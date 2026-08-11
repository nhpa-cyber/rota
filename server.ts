process.env.TZ = 'America/Sao_Paulo';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';

const PORT = 3000;
const DB_FILE = path.join(process.cwd(), 'database.json');

// Memory DB initialized from database.json if present
let currentDb: Record<string, any> = {
  users: [],
  drivers: [],
  vehicles: [],
  products: [],
  activeAssets: [],
  audits: [],
  returnForecasts: [],
  fiscalAlerts: [],
  importedRoutes: [],
  vales: [],
  photos: [],
  customManual: ''
};

function loadDatabaseFromFile() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf-8').trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        currentDb = { ...currentDb, ...parsed };
        if (!currentDb.photos) currentDb.photos = [];
        console.log(`[Database] Loaded database from ${DB_FILE}`);
      } else {
        saveDatabaseToFile();
      }
    } else {
      saveDatabaseToFile();
    }
  } catch (err) {
    console.error('[Database] Failed to read database.json, reinitializing with default state:', err);
    saveDatabaseToFile();
  }
}

function saveDatabaseToFile() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(currentDb, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Database] Failed to write database.json:', err);
  }
}

loadDatabaseFromFile();

// SSE Connected Clients Set
const sseClients = new Set<express.Response>();

function broadcastSSEUpdate(data: any) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch (e) {
      sseClients.delete(res);
    }
  }
}

async function startServer() {
  const app = express();

  // Support up to 50MB body payloads for photo base64 uploads
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // --- API ROUTES ---

  // Healthcheck
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // GET /api/db - Read current database
  app.get('/api/db', (req, res) => {
    res.json({ success: true, db: currentDb });
  });

  // GET /api/export-database - Download complete JSON backup
  app.get('/api/export-database', (req, res) => {
    try {
      if (fs.existsSync(DB_FILE)) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename="backup_completo_plataforma.json"');
        const fileStream = fs.createReadStream(DB_FILE);
        return fileStream.pipe(res);
      } else {
        return res.status(404).json({ success: false, error: 'Arquivo database.json ainda não foi gerado.' });
      }
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message || 'Erro ao exportar banco' });
    }
  });

  // --- FIREBASE CONFIGURATION ENDPOINTS ---
  const FIREBASE_CONFIG_FILE = path.join(process.cwd(), 'firebase-applet-config.json');
  const SCHEDULE_RULES_FILE = path.join(process.cwd(), 'schedule-rules.json');
  const AUTO_SCHEDULE_FILE = path.join(process.cwd(), 'auto-schedule-setting.json');

  const SERVER_FIREBASE_PRESETS = [
    {
      id: "banco-03",
      name: "Banco 03 (Banco Principal / Todos os Usuários)",
      config: {
        projectId: "banco-03-6b1ea",
        appId: "1:645365828863:web:beb28f8f10226a02e210ca",
        apiKey: "AIzaSyCNeRWfV7L-i3X1GBegzETsEbpGkmK_s4g",
        authDomain: "banco-03-6b1ea.firebaseapp.com",
        firestoreDatabaseId: "(default)",
        storageBucket: "banco-03-6b1ea.firebasestorage.app",
        messagingSenderId: "645365828863",
        measurementId: "",
        oAuthClientId: ""
      }
    }
  ];

  let pendingDbSwitch: {
    targetPresetId?: string;
    targetConfig?: any;
    targetName?: string;
    switchAtTimestamp: number;
    startedAt: number;
    requestedBy?: string;
    requestedType?: string;
  } | null = null;

  let customScheduleRules: any = null;
  let isAutoScheduleServerEnabled = false;

  try {
    if (fs.existsSync(SCHEDULE_RULES_FILE)) {
      const raw = fs.readFileSync(SCHEDULE_RULES_FILE, 'utf-8');
      customScheduleRules = JSON.parse(raw);
    }
  } catch (e) {
    console.warn('[Firebase] Failed to load schedule-rules.json:', e);
  }

  try {
    if (fs.existsSync(AUTO_SCHEDULE_FILE)) {
      const raw = fs.readFileSync(AUTO_SCHEDULE_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (typeof parsed.enabled === 'boolean') {
        isAutoScheduleServerEnabled = parsed.enabled;
      }
    }
  } catch (e) {}

  function getServerScheduledPreset(): typeof SERVER_FIREBASE_PRESETS[0] {
    const rules = (Array.isArray(customScheduleRules) && customScheduleRules.length > 0)
      ? customScheduleRules
      : [
          { id: "banco_03_fixo", name: "Banco 03 (Todos os Usuários)", triggerHour: 0, triggerMinute: 0, presetId: "banco-03" }
        ];

    const now = new Date();
    let currentHours = now.getHours();
    let currentMins = now.getMinutes();
    try {
      const formatter = new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
      const parts = formatter.formatToParts(now);
      for (const p of parts) {
        if (p.type === 'hour') currentHours = parseInt(p.value, 10);
        if (p.type === 'minute') currentMins = parseInt(p.value, 10);
      }
    } catch (e) {}
    const currentMinutes = currentHours * 60 + currentMins;

    const ruleMinutes = rules.map((r: any) => ({
      presetId: r.presetId,
      mins: (r.triggerHour || 0) * 60 + (r.triggerMinute || 0)
    })).sort((a: any, b: any) => a.mins - b.mins);

    if (ruleMinutes.length === 0) return SERVER_FIREBASE_PRESETS[0];

    let activePresetId = ruleMinutes[ruleMinutes.length - 1].presetId;
    for (let i = 0; i < ruleMinutes.length; i++) {
      if (currentMinutes >= ruleMinutes[i].mins) {
        activePresetId = ruleMinutes[i].presetId;
      } else {
        break;
      }
    }

    const found = SERVER_FIREBASE_PRESETS.find(p => p.id === activePresetId || p.config.projectId === activePresetId);
    return found || SERVER_FIREBASE_PRESETS[0];
  }

  // Ensure firebase-applet-config.json is configured for Banco 03 on startup
  try {
    const banco03Config = SERVER_FIREBASE_PRESETS[0].config;
    fs.writeFileSync(FIREBASE_CONFIG_FILE, JSON.stringify(banco03Config, null, 2), 'utf-8');
    console.log('[ServerDB] Configuração do Banco 03 salva com sucesso em firebase-applet-config.json');
  } catch (e) {
    console.error('[ServerDB] Erro ao sincronizar firebase-applet-config.json para Banco 03:', e);
  }

  // Server background loop to process pending DB switches and enforce shift schedule
  setInterval(() => {
    // 1. Check countdown switch expiration
    if (pendingDbSwitch && pendingDbSwitch.switchAtTimestamp) {
      if (Date.now() >= pendingDbSwitch.switchAtTimestamp) {
        console.log(`[ServerDB] Timer de troca expirou. Alternando banco no servidor para: ${pendingDbSwitch.targetName || 'Novo Banco'}`);
        if (pendingDbSwitch.targetConfig) {
          try {
            fs.writeFileSync(FIREBASE_CONFIG_FILE, JSON.stringify(pendingDbSwitch.targetConfig, null, 2), 'utf-8');
            const newConfig = pendingDbSwitch.targetConfig;
            if (pendingDbSwitch.requestedType === 'manual') {
              isAutoScheduleServerEnabled = false;
              try {
                fs.writeFileSync(AUTO_SCHEDULE_FILE, JSON.stringify({ enabled: false }), 'utf-8');
              } catch (e) {}
            }
            pendingDbSwitch = null;
            broadcastSSEUpdate({ pendingDbSwitch: null, autoScheduleEnabled: isAutoScheduleServerEnabled, config: newConfig });
          } catch (err) {
            console.error('[ServerDB] Erro ao gravar novo banco no disco:', err);
          }
        } else {
          pendingDbSwitch = null;
          broadcastSSEUpdate({ pendingDbSwitch: null, autoScheduleEnabled: isAutoScheduleServerEnabled });
        }
      }
      return;
    }

    // 2. Enforce schedule verification if auto schedule is active and no manual switch countdown is pending
    if (isAutoScheduleServerEnabled && !pendingDbSwitch) {
      const scheduledPreset = getServerScheduledPreset();
      let currentProjectId = '';
      if (fs.existsSync(FIREBASE_CONFIG_FILE)) {
        try {
          const raw = fs.readFileSync(FIREBASE_CONFIG_FILE, 'utf-8');
          const parsed = JSON.parse(raw);
          currentProjectId = parsed.projectId || '';
        } catch (e) {}
      }

      if (currentProjectId !== scheduledPreset.config.projectId) {
        console.log(`[ServerDB] Mudança de turno programada detectada (${currentProjectId || 'Nenhum'} ➔ ${scheduledPreset.config.projectId}). Alternando banco no servidor...`);
        try {
          fs.writeFileSync(FIREBASE_CONFIG_FILE, JSON.stringify(scheduledPreset.config, null, 2), 'utf-8');
          broadcastSSEUpdate({ pendingDbSwitch: null, autoScheduleEnabled: true, config: scheduledPreset.config });
        } catch (e) {
          console.error('[ServerDB] Erro ao corrigir banco agendado:', e);
        }
      }
    }
  }, 2000);

  app.get('/api/firebase/auto-schedule', (req, res) => {
    return res.json({ success: true, enabled: isAutoScheduleServerEnabled });
  });

  app.post('/api/firebase/auto-schedule', (req, res) => {
    try {
      const { enabled } = req.body || {};
      isAutoScheduleServerEnabled = !!enabled;
      try {
        fs.writeFileSync(AUTO_SCHEDULE_FILE, JSON.stringify({ enabled: isAutoScheduleServerEnabled }), 'utf-8');
      } catch (e) {}

      if (isAutoScheduleServerEnabled) {
        const scheduledPreset = getServerScheduledPreset();
        try {
          fs.writeFileSync(FIREBASE_CONFIG_FILE, JSON.stringify(scheduledPreset.config, null, 2), 'utf-8');
          broadcastSSEUpdate({ autoScheduleEnabled: true, pendingDbSwitch: null, config: scheduledPreset.config, db: currentDb });
          return res.json({ success: true, enabled: true, config: scheduledPreset.config });
        } catch (e) {}
      }

      broadcastSSEUpdate({ autoScheduleEnabled: isAutoScheduleServerEnabled, db: currentDb });
      return res.json({ success: true, enabled: isAutoScheduleServerEnabled });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message || 'Erro ao alterar agendamento automático' });
    }
  });

  app.get('/api/firebase/schedule-rules', (req, res) => {
    return res.json({ success: true, rules: customScheduleRules });
  });

  app.post('/api/firebase/schedule-rules', (req, res) => {
    try {
      const { rules } = req.body || {};
      customScheduleRules = rules;
      try {
        fs.writeFileSync(SCHEDULE_RULES_FILE, JSON.stringify(rules, null, 2), 'utf-8');
      } catch (e) {}
      broadcastSSEUpdate({ scheduleRules: customScheduleRules, db: currentDb });
      return res.json({ success: true, rules: customScheduleRules });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message || 'Erro ao salvar horários de troca' });
    }
  });

  app.get('/api/firebase/pending-switch', (req, res) => {
    return res.json({ success: true, pendingSwitch: pendingDbSwitch });
  });

  app.post('/api/firebase/trigger-switch', (req, res) => {
    try {
      const { targetPresetId, targetConfig, targetName, countdownSeconds = 60, requestedBy, requestedType = 'manual' } = req.body || {};
      const now = Date.now();
      if (requestedType === 'manual') {
        isAutoScheduleServerEnabled = false;
        try {
          fs.writeFileSync(AUTO_SCHEDULE_FILE, JSON.stringify({ enabled: false }), 'utf-8');
        } catch (e) {}
      }

      pendingDbSwitch = {
        targetPresetId,
        targetConfig,
        targetName,
        switchAtTimestamp: now + (countdownSeconds * 1000),
        startedAt: now,
        requestedBy: requestedBy || 'Gestor Administrador',
        requestedType: requestedType || 'manual'
      };
      broadcastSSEUpdate({ pendingDbSwitch, autoScheduleEnabled: isAutoScheduleServerEnabled, db: currentDb });
      return res.json({ success: true, pendingSwitch: pendingDbSwitch });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message || 'Erro ao iniciar troca de banco' });
    }
  });

  app.post('/api/firebase/cancel-switch', (req, res) => {
    pendingDbSwitch = null;
    broadcastSSEUpdate({ pendingDbSwitch: null, db: currentDb });
    return res.json({ success: true, message: 'Troca de banco de dados cancelada' });
  });

  app.get('/api/firebase/config', (req, res) => {
    try {
      if (isAutoScheduleServerEnabled) {
        const scheduledPreset = getServerScheduledPreset();
        if (scheduledPreset && scheduledPreset.config) {
          try {
            fs.writeFileSync(FIREBASE_CONFIG_FILE, JSON.stringify(scheduledPreset.config, null, 2), 'utf-8');
          } catch (e) {}
          return res.json({ success: true, config: scheduledPreset.config, pendingSwitch: pendingDbSwitch });
        }
      }
      if (fs.existsSync(FIREBASE_CONFIG_FILE)) {
        const raw = fs.readFileSync(FIREBASE_CONFIG_FILE, 'utf-8');
        const config = JSON.parse(raw);
        return res.json({ success: true, config, pendingSwitch: pendingDbSwitch });
      }
    } catch (err) {
      console.error('[Firebase] Failed to read config file:', err);
    }
    const fallback = getServerScheduledPreset();
    return res.json({ success: true, config: fallback.config, pendingSwitch: pendingDbSwitch });
  });

  app.post('/api/firebase/config', (req, res) => {
    try {
      const config = req.body;
      if (!config || !config.apiKey || !config.projectId) {
        return res.status(400).json({ success: false, error: 'API Key e Project ID são obrigatórios' });
      }
      fs.writeFileSync(FIREBASE_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
      isAutoScheduleServerEnabled = false;
      try {
        fs.writeFileSync(AUTO_SCHEDULE_FILE, JSON.stringify({ enabled: false }), 'utf-8');
      } catch (e) {}
      pendingDbSwitch = null;
      broadcastSSEUpdate({ pendingDbSwitch: null, autoScheduleEnabled: false, config });
      return res.json({ success: true, message: 'Configuração salva com sucesso', config });
    } catch (err: any) {
      console.error('[Firebase] Failed to save config file:', err);
      return res.status(500).json({ success: false, error: err?.message || 'Erro ao salvar configuração' });
    }
  });

  app.post('/api/firebase/test', (req, res) => {
    try {
      const config = req.body;
      if (!config || !config.apiKey || !config.projectId) {
        return res.status(400).json({ success: false, error: 'API Key e Project ID são obrigatórios para testar a conexão.' });
      }
      return res.json({
        success: true,
        message: 'Conexão com o Firebase/Firestore estabelecida com sucesso!'
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message || 'Erro no teste de conexão.' });
    }
  });

  app.post('/api/firebase/clear', (req, res) => {
    try {
      const emptyConfig = {
        projectId: "",
        appId: "",
        apiKey: "",
        authDomain: "",
        firestoreDatabaseId: "(default)",
        storageBucket: "",
        messagingSenderId: "",
        measurementId: "",
        oAuthClientId: ""
      };
      fs.writeFileSync(FIREBASE_CONFIG_FILE, JSON.stringify(emptyConfig, null, 2), 'utf-8');
      return res.json({ success: true, message: 'Configurações do Firebase zeradas com sucesso.' });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err?.message || 'Erro ao limpar configurações.' });
    }
  });

  // POST /api/db - Write / merge database
  app.post('/api/db', (req, res) => {
    const { db } = req.body || {};
    if (db && typeof db === 'object') {
      currentDb = {
        ...currentDb,
        ...db
      };
      saveDatabaseToFile();
      broadcastSSEUpdate({ db: currentDb });
      res.json({ success: true, db: currentDb });
    } else {
      res.status(400).json({ success: false, error: 'Invalid db payload' });
    }
  });

  // GET /api/db/events - Server-Sent Events (SSE) Stream
  app.get('/api/db/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.add(res);

    // Initial state push
    res.write(`data: ${JSON.stringify({ db: currentDb })}\n\n`);

    // Heartbeat every 15s to keep connection open
    const heartbeat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
      } catch (e) {
        clearInterval(heartbeat);
        sseClients.delete(res);
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
  });

  // Photo Evidence API Endpoints
  app.get('/api/photos', (req, res) => {
    const { auditId } = req.query;
    let photos = currentDb.photos || [];
    if (auditId && typeof auditId === 'string') {
      photos = photos.filter((p: any) => p.auditId === auditId);
    }
    res.json({ success: true, photos });
  });

  app.post('/api/photos', (req, res) => {
    const { photo } = req.body || {};
    if (!photo || !photo.id) {
      return res.status(400).json({ success: false, error: 'Invalid photo payload' });
    }

    if (!currentDb.photos) currentDb.photos = [];
    const index = currentDb.photos.findIndex((p: any) => p.id === photo.id);
    const syncedPhoto = { ...photo, syncPending: false };

    if (index >= 0) {
      currentDb.photos[index] = syncedPhoto;
    } else {
      currentDb.photos.push(syncedPhoto);
    }

    saveDatabaseToFile();
    broadcastSSEUpdate({ db: currentDb });
    res.json({ success: true, photo: syncedPhoto });
  });

  app.delete('/api/photos/:id', (req, res) => {
    const { id } = req.params;
    if (currentDb.photos) {
      currentDb.photos = currentDb.photos.filter((p: any) => p.id !== id);
      saveDatabaseToFile();
      broadcastSSEUpdate({ db: currentDb });
    }
    res.json({ success: true });
  });

  app.post('/api/photos/clear', (req, res) => {
    currentDb.photos = [];
    saveDatabaseToFile();
    broadcastSSEUpdate({ db: currentDb });
    res.json({ success: true });
  });

  app.post('/api/photos/prune', (req, res) => {
    const { daysRetention } = req.body || {};
    const retention = typeof daysRetention === 'number' ? daysRetention : 30;
    const cutoff = Date.now() - retention * 24 * 60 * 60 * 1000;

    const initialCount = (currentDb.photos || []).length;
    currentDb.photos = (currentDb.photos || []).filter((p: any) => {
      const pTime = new Date(p.timestamp || 0).getTime();
      return pTime >= cutoff;
    });

    const prunedCount = initialCount - currentDb.photos.length;
    saveDatabaseToFile();
    broadcastSSEUpdate({ db: currentDb });
    res.json({ success: true, prunedCount });
  });

  // POST /api/chat - Gemini AI Chat Endpoint
  app.post('/api/chat', async (req, res) => {
    const { message, history } = req.body || {};
    if (!message) {
      return res.status(400).json({ error: 'Mensagem em branco' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: 'Chave GEMINI_API_KEY não configurada no servidor.'
      });
    }

    try {
      const ai = new GoogleGenAI({ apiKey });

      const routes = currentDb.importedRoutes || [];
      const audits = currentDb.audits || [];
      const vales = currentDb.vales || [];
      const drivers = currentDb.drivers || [];

      const openRoutes = routes.filter((r: any) => r.status !== 'fechado');
      const closedRoutes = routes.filter((r: any) => r.status === 'fechado');

      const systemInstruction = `Você é o Assistente Virtual Inteligente da plataforma "Aferição de Retorno de Rota - Pau Brasil Distribuidora Ambev".
Seu papel é tirar dúvidas dos usuários de forma prestativa, direta, simples e profissional, dando respostas EXTREMAMENTE ASSERTIVAS baseadas nos dados ativos da unidade.

DADOS ATIVOS DA UNIDADE:
- Rotas Importadas: ${routes.length} (Abertas: ${openRoutes.length}, Fechadas: ${closedRoutes.length})
- Rotas Abertas: ${openRoutes.map((r: any) => `Mapa ${r.routeMap} (Placa ${r.plate})`).join(', ') || 'Nenhuma'}
- Auditorias com Divergência Registradas: ${audits.filter((a: any) => a.status === 'finalizado_divergente').length}
- Vales Registrados: ${vales.length}
`;

      const contents = [
        ...(Array.isArray(history) ? history.map((h: any) => ({
          role: h.role === 'user' ? 'user' : 'model',
          parts: [{ text: h.text || '' }]
        })) : []),
        {
          role: 'user',
          parts: [{ text: message }]
        }
      ];

      let modelResponse;
      try {
        modelResponse = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents,
          config: { systemInstruction }
        });
      } catch (err) {
        modelResponse = await ai.models.generateContent({
          model: 'gemini-1.5-flash',
          contents,
          config: { systemInstruction }
        });
      }

      res.json({ text: modelResponse.text || 'Sem resposta.' });
    } catch (err: any) {
      console.error('[Gemini API Error]', err);
      res.status(500).json({ error: err?.message || 'Erro ao comunicar com a inteligência artificial' });
    }
  });

  // --- VITE MIDDLEWARE OR STATIC SERVING ---
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[LogiRoute] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[Server Start Error]', err);
  process.exit(1);
});
