import React, { useState, useRef } from 'react';
import { 
  Download, 
  Database, 
  FileJson, 
  FileSpreadsheet, 
  CheckCircle2, 
  RefreshCw, 
  Sparkles, 
  Server, 
  HardDrive, 
  Layers, 
  Table, 
  FolderDown, 
  Box, 
  Truck, 
  Users, 
  Ticket, 
  AlertTriangle,
  Upload,
  FolderUp,
  AlertCircle,
  FileCheck,
  ShieldCheck,
  UserPlus
} from 'lucide-react';
import { User, Driver, Vehicle, Product, ActiveAsset, AuditSession, ImportedRoute, Vale } from '../types';
import { getActiveFirebaseConfig, getClientFirestore } from '../clientFirebase';
import { doc, setDoc, collection } from 'firebase/firestore';
import { parseAndProcessFile, ProcessImportResult } from '../utils/excelImportHelper';

interface ExportDataViewProps {
  currentUser: User;
  drivers: Driver[];
  vehicles: Vehicle[];
  products: Product[];
  activeAssets: ActiveAsset[];
  audits: AuditSession[];
  users: User[];
  importedRoutes: ImportedRoute[];
  vales: Vale[];
  auditLogs?: any[];
  customManualHTML?: string;
}

export default function ExportDataView({
  currentUser,
  drivers,
  vehicles,
  products,
  activeAssets,
  audits,
  users,
  importedRoutes,
  vales,
  auditLogs = [],
  customManualHTML = ''
}: ExportDataViewProps) {
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [exportSuccessMsg, setExportSuccessMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeConfig = getActiveFirebaseConfig();
  const activeProjectId = activeConfig?.projectId || 'banco-03-6b1ea';

  const [retroImportResult, setRetroImportResult] = useState<ProcessImportResult | null>(null);
  const [isProcessingRetro, setIsProcessingRetro] = useState(false);
  const refugoFileInputRef = useRef<HTMLInputElement>(null);

  // Handle uploading custom Excel (.xlsx, .xls, .csv) or JSON for Retroactive Refugos
  const handleRetroFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessingRetro(true);
    setExportSuccessMsg(`Analisando arquivo '${file.name}'...`);

    try {
      const result = await parseAndProcessFile(file, audits, drivers);
      setRetroImportResult(result);
      setExportSuccessMsg(`Arquivo '${file.name}' analisado! ${result.auditsToSave.length} auditorias prontas para salvar.`);
    } catch (err: any) {
      console.error('Erro ao analisar arquivo:', err);
      alert('Erro ao analisar planilha ou JSON: ' + (err?.message || 'Arquivo inválido'));
    } finally {
      setIsProcessingRetro(false);
      if (refugoFileInputRef.current) refugoFileInputRef.current.value = '';
    }
  };

  // Pre-loaded 1-click import for public/audits_retroativos_import.json
  const handleImportPreloadedRetroJson = async () => {
    setIsProcessingRetro(true);
    setExportSuccessMsg('Buscando dataset oficial "audits_retroativos_import.json"...');

    try {
      const res = await fetch('/audits_retroativos_import.json');
      if (!res.ok) throw new Error('Arquivo audits_retroativos_import.json não encontrado no servidor');
      const json = await res.json();

      let auditsList: any[] = json.collections?.audits || json.audits || [];
      const blob = new Blob([JSON.stringify(auditsList)], { type: 'application/json' });
      const file = new File([blob], 'audits_retroativos_import.json', { type: 'application/json' });

      const result = await parseAndProcessFile(file, audits, drivers);
      setRetroImportResult(result);
      setExportSuccessMsg(`Dataset oficial carregado! ${result.auditsToSave.length} auditorias prontas para salvar.`);
    } catch (err: any) {
      console.error('Erro ao carregar JSON pré-gerado:', err);
      alert('Erro ao carregar arquivo oficial: ' + err.message);
    } finally {
      setIsProcessingRetro(false);
    }
  };

  // Save Retroactive Audit Import to Firestore
  const handleConfirmSaveRetroAudits = async () => {
    if (!retroImportResult || retroImportResult.auditsToSave.length === 0) return;

    setIsImporting(true);
    setExportSuccessMsg(`Gravando ${retroImportResult.auditsToSave.length} auditorias e ${retroImportResult.unregisteredDriversCount} motoristas no banco '${activeProjectId}'...`);

    try {
      const db = getClientFirestore();
      let totalSavedAudits = 0;
      let totalSavedDrivers = 0;

      if (db) {
        // 1. Save new drivers
        for (const drv of retroImportResult.newDriversToSave) {
          const drvRef = doc(collection(db, 'drivers'), drv.id);
          await setDoc(drvRef, drv, { merge: true });
          totalSavedDrivers++;
        }

        // 2. Save audit documents
        for (const audit of retroImportResult.auditsToSave) {
          const auditRef = doc(collection(db, 'audits'), audit.id);
          const auditData = { ...audit };
          await setDoc(auditRef, auditData, { merge: true });
          totalSavedAudits++;
        }
      }

      setExportSuccessMsg(`Importação concluída com sucesso! ${totalSavedAudits} registros de refugo e ${totalSavedDrivers} novos motoristas gravados no '${activeProjectId}'. Atualizando visualização...`);
      setRetroImportResult(null);

      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } catch (err: any) {
      console.error('Erro ao salvar auditorias retroativas:', err);
      alert('Falha ao salvar no Firestore: ' + (err?.message || 'Erro desconhecido'));
    } finally {
      setIsImporting(false);
    }
  };

  // Import / Restore 100% JSON Backup File into Active Firebase + Local Memory
  const handleImportFullDatabaseJSON = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!confirm(`Deseja importar os dados do arquivo '${file.name}' para o banco ativo '${activeProjectId}'? Todos os registros serão mesclados/restaurados.`)) {
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setIsImporting(true);
    setExportSuccessMsg(`Lendo e restaurando backup '${file.name}'...`);

    try {
      const text = await file.text();
      const backupData = JSON.parse(text);

      let totalRestoredDocs = 0;
      const db = getClientFirestore();

      // 1. Restore from clientLiveState or serverDatabaseDump or root collections
      const collectionsToRestore = backupData.clientLiveState || backupData.serverDatabaseDump?.collections || backupData.collections;

      if (collectionsToRestore && typeof collectionsToRestore === 'object') {
        const collectionsMap: Record<string, any[]> = {};

        // Normalizing data format
        if (backupData.clientLiveState) {
          collectionsMap['users'] = backupData.clientLiveState.users || [];
          collectionsMap['drivers'] = backupData.clientLiveState.drivers || [];
          collectionsMap['vehicles'] = backupData.clientLiveState.vehicles || [];
          collectionsMap['products'] = backupData.clientLiveState.products || [];
          collectionsMap['activeAssets'] = backupData.clientLiveState.activeAssets || [];
          collectionsMap['audits'] = backupData.clientLiveState.audits || [];
          collectionsMap['vales'] = backupData.clientLiveState.vales || [];
          collectionsMap['importedRoutes'] = backupData.clientLiveState.importedRoutes || [];
          collectionsMap['auditLogs'] = backupData.clientLiveState.auditLogs || [];
        } else if (backupData.serverDatabaseDump?.collections) {
          Object.assign(collectionsMap, backupData.serverDatabaseDump.collections);
        } else if (backupData.collections) {
          Object.assign(collectionsMap, backupData.collections);
        }

        if (db) {
          for (const [colName, items] of Object.entries(collectionsMap)) {
            if (Array.isArray(items)) {
              for (const item of items) {
                if (item && item.id) {
                  const itemCopy = { ...item };
                  const docId = itemCopy.id;
                  delete itemCopy.id;
                  const docRef = doc(collection(db, colName), String(docId));
                  await setDoc(docRef, itemCopy, { merge: true });
                  totalRestoredDocs++;
                }
              }
            }
          }
        }
      }

      // 2. Restore browserLocalStorage if present
      if (backupData.browserLocalStorage) {
        for (const [key, value] of Object.entries(backupData.browserLocalStorage)) {
          try {
            localStorage.setItem(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
          } catch (e) {}
        }
      }

      setExportSuccessMsg(`Backup restaurado com sucesso! ${totalRestoredDocs} documentos sincronizados para '${activeProjectId}'. Atualizando a tela...`);
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } catch (err: any) {
      console.error("Erro ao importar backup:", err);
      alert("Falha ao importar backup JSON: " + (err?.message || "Arquivo JSON inválido"));
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Helper to trigger file download in browser
  const downloadFile = (filename: string, content: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Helper to convert JSON array to CSV format
  const jsonToCsv = (items: any[]) => {
    if (!items || !items.length) return '';
    
    // Flatten nested keys
    const keys = Object.keys(items[0]).filter(k => typeof items[0][k] !== 'object' && typeof items[0][k] !== 'function');
    const header = keys.join(';');
    const rows = items.map(item => {
      return keys.map(key => {
        let val = item[key];
        if (val === null || val === undefined) val = '';
        val = String(val).replace(/"/g, '""').replace(/;/g, ',');
        return `"${val}"`;
      }).join(';');
    });

    return [header, ...rows].join('\n');
  };

  // Download 100% Complete JSON Backup (combines Firebase Database + Local Memory)
  const handleExportFullDatabaseJSON = async () => {
    setIsExporting(true);
    setExportSuccessMsg('Gerando e consolidando 100% da base de dados...');

    try {
      // 1. Try fetching full dump from server API endpoint
      let serverData: any = null;
      try {
        const res = await fetch('/api/export-database');
        if (res.ok) {
          serverData = await res.json();
        }
      } catch (e) {
        console.warn('Servidor local não respondeu, consolidando dados em memória/cliente:', e);
      }

      // 2. Gather localStorage
      const localStorageDump: Record<string, any> = {};
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key) {
            try {
              localStorageDump[key] = JSON.parse(localStorage.getItem(key) || '""');
            } catch {
              localStorageDump[key] = localStorage.getItem(key);
            }
          }
        }
      } catch (e) {}

      // 3. Build ultimate 100% payload
      const fullPayload = {
        exportedAt: new Date().toISOString(),
        exportedBy: currentUser.name,
        activeFirebaseProject: activeProjectId,
        summaryCounts: {
          importedRoutes: importedRoutes.length,
          audits: audits.length,
          vales: vales.length,
          products: products.length,
          drivers: drivers.length,
          vehicles: vehicles.length,
          users: users.length,
          activeAssets: activeAssets.length,
          auditLogs: auditLogs.length
        },
        serverDatabaseDump: serverData || null,
        clientLiveState: {
          importedRoutes,
          audits,
          vales,
          products,
          drivers,
          vehicles,
          users,
          activeAssets,
          auditLogs,
          customManualHTML
        },
        browserLocalStorage: localStorageDump
      };

      const jsonString = JSON.stringify(fullPayload, null, 2);
      const filename = `backup_completo_100pct_${activeProjectId}_${new Date().toISOString().split('T')[0]}.json`;
      downloadFile(filename, jsonString, 'application/json');

      setExportSuccessMsg('Backup de 100% da plataforma baixado com sucesso!');
    } catch (err: any) {
      console.error('Erro ao exportar banco:', err);
      alert('Erro ao exportar arquivo: ' + (err?.message || 'Falha desconhecida'));
    } finally {
      setIsExporting(false);
    }
  };

  // Generic exporter for individual modules
  const exportModuleData = (moduleName: string, data: any[], filenamePrefix: string, format: 'json' | 'csv') => {
    if (!data || data.length === 0) {
      alert(`A base de dados de ${moduleName} está vazia no momento.`);
      return;
    }

    const dateStr = new Date().toISOString().split('T')[0];
    if (format === 'json') {
      const content = JSON.stringify(data, null, 2);
      downloadFile(`${filenamePrefix}_${dateStr}.json`, content, 'application/json');
    } else {
      const csv = jsonToCsv(data);
      downloadFile(`${filenamePrefix}_${dateStr}.csv`, csv, 'text/csv;charset=utf-8;');
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Top Section Header */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center space-x-3">
          <div className="p-3 bg-blue-50 text-blue-600 rounded-xl border border-blue-100">
            <FolderDown className="h-6 w-6" />
          </div>
          <div>
            <h3 className="font-sans font-bold text-base text-slate-900">
              Exportação e Backup Total da Plataforma
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Extraia 100% de todos os registros do banco de dados Firebase e memória local em arquivos estruturados JSON e CSV.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs font-bold bg-slate-100 text-slate-800 px-3 py-1.5 rounded-xl border border-slate-200 flex items-center gap-1.5">
            <Server className="h-3.5 w-3.5 text-blue-600" />
            <span>Banco Conectado: <strong className="text-blue-700">{activeProjectId}</strong></span>
          </span>
        </div>
      </div>

      {/* Main 100% Total Export High-Contrast Hero Card */}
      <div className="bg-white border-2 border-emerald-500/30 rounded-2xl p-6 shadow-sm relative overflow-hidden">
        <div className="space-y-5">
          {/* Badge */}
          <div className="flex items-center space-x-2">
            <span className="bg-emerald-100 text-emerald-900 border border-emerald-300 text-xs font-extrabold uppercase tracking-wider px-3 py-1 rounded-full flex items-center gap-1.5 shadow-2xs">
              <Sparkles className="h-3.5 w-3.5 text-emerald-600" />
              <span>BACKUP INTEGRAL (100% DOS DADOS)</span>
            </span>
            <span className="text-slate-500 text-xs font-medium">• Todas as Coleções + Cache Local</span>
          </div>

          {/* Heading */}
          <div>
            <h4 className="text-xl font-black text-slate-900 tracking-tight">
              Exportar Todo o Banco de Dados (100% em Arquivo JSON)
            </h4>
            <p className="text-xs text-slate-600 mt-1 max-w-3xl leading-relaxed">
              Esta ação cria um arquivo único consolidado com absolutamente todos os módulos: Painel Gerencial, Contagens Físicas de Conferentes, Conciliação Fiscal, Sobras/Faltas, Gestão de Vales, Monitoramento, Históricos, Sincronizador e Cadastros Gerais.
            </p>
          </div>

          {/* Real Metrics Grid - High Contrast */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3 pt-1">
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-center shadow-2xs">
              <span className="block text-[10px] text-slate-500 font-bold uppercase tracking-wider">Rotas Importadas</span>
              <span className="text-xl font-black text-slate-900 mt-0.5 block">{importedRoutes.length}</span>
            </div>
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-center shadow-2xs">
              <span className="block text-[10px] text-slate-500 font-bold uppercase tracking-wider">Auditorias</span>
              <span className="text-xl font-black text-slate-900 mt-0.5 block">{audits.length}</span>
            </div>
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-center shadow-2xs">
              <span className="block text-[10px] text-slate-500 font-bold uppercase tracking-wider">Vales Emitidos</span>
              <span className="text-xl font-black text-slate-900 mt-0.5 block">{vales.length}</span>
            </div>
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-center shadow-2xs">
              <span className="block text-[10px] text-slate-500 font-bold uppercase tracking-wider">Produtos</span>
              <span className="text-xl font-black text-slate-900 mt-0.5 block">{products.length}</span>
            </div>
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-center shadow-2xs">
              <span className="block text-[10px] text-slate-500 font-bold uppercase tracking-wider">Motoristas</span>
              <span className="text-xl font-black text-slate-900 mt-0.5 block">{drivers.length}</span>
            </div>
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-center shadow-2xs">
              <span className="block text-[10px] text-slate-500 font-bold uppercase tracking-wider">Usuários</span>
              <span className="text-xl font-black text-slate-900 mt-0.5 block">{users.length}</span>
            </div>
          </div>

          {/* Download & Restore Action Buttons */}
          <div className="pt-2 flex flex-wrap items-center gap-3">
            <button
              onClick={handleExportFullDatabaseJSON}
              disabled={isExporting || isImporting}
              className="bg-emerald-600 hover:bg-emerald-700 active:scale-98 text-white font-black text-xs px-6 py-3.5 rounded-xl flex items-center space-x-2.5 shadow-md shadow-emerald-600/20 transition cursor-pointer"
            >
              {isExporting ? (
                <RefreshCw className="h-4 w-4 animate-spin text-white" />
              ) : (
                <Download className="h-4 w-4 text-white" />
              )}
              <span>BAIXAR BACKUP COMPLETO DA PLATAFORMA (100% JSON)</span>
            </button>

            {/* Import / Restore Button */}
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleImportFullDatabaseJSON}
              accept=".json"
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isExporting || isImporting}
              className="bg-blue-600 hover:bg-blue-700 active:scale-98 text-white font-black text-xs px-5 py-3.5 rounded-xl flex items-center space-x-2 shadow-md shadow-blue-600/20 transition cursor-pointer"
            >
              {isImporting ? (
                <RefreshCw className="h-4 w-4 animate-spin text-white" />
              ) : (
                <Upload className="h-4 w-4 text-white" />
              )}
              <span>RESTAURAR / IMPORTAR BACKUP JSON (100%)</span>
            </button>

            <a
              href="/api/export-database"
              download="backup_completo_plataforma.json"
              className="bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs px-5 py-3.5 rounded-xl flex items-center space-x-2 border border-slate-900 shadow-xs transition cursor-pointer"
            >
              <FileJson className="h-4 w-4 text-emerald-400" />
              <span>Download Direto Servidor (.json)</span>
            </a>
          </div>

          {exportSuccessMsg && (
            <div className="p-3.5 bg-emerald-50 border border-emerald-300 rounded-xl text-xs font-bold text-emerald-900 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
              <span>{exportSuccessMsg}</span>
            </div>
          )}
        </div>
      </div>

      {/* RETROACTIVE REFUGO & AVARIA IMPORT CARD */}
      <div className="bg-white border-2 border-amber-500/30 rounded-2xl p-6 shadow-sm space-y-5 relative overflow-hidden" id="card_import_refugo_retroativo">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
          <div className="flex items-center space-x-2.5">
            <span className="bg-amber-100 text-amber-900 border border-amber-300 text-xs font-black uppercase tracking-wider px-3 py-1 rounded-full flex items-center gap-1.5 shadow-2xs">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
              <span>IMPORTAÇÃO RETROATIVA DE REFUGO & AVARIA</span>
            </span>
            <span className="text-slate-500 text-xs font-medium">• Planilhas Excel (.xlsx/.xls/.csv) ou JSON</span>
          </div>
          <span className="text-xxs font-bold bg-slate-100 text-slate-700 px-2.5 py-1 rounded-lg border border-slate-200">
            Destino: Collection 'audits' ({activeProjectId})
          </span>
        </div>

        <div>
          <h4 className="text-lg font-black text-slate-900 tracking-tight">
            Importar Registros de Refugo/Avaria (Excel / CSV / JSON)
          </h4>
          <p className="text-xs text-slate-600 mt-1 max-w-3xl leading-relaxed">
            Importe mapas retroativos da aba <strong className="text-slate-800 font-bold">Import_Refugo_Rota</strong> de planilhas Excel ou do dataset oficial <strong className="text-slate-800 font-bold">audits_retroativos_import.json</strong>.
            Garante a preservação de dados reais de conferências físicas já registradas.
          </p>
        </div>

        {/* Protection Rules Badge Bar */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="bg-amber-50/60 border border-amber-200/80 rounded-xl p-3 flex items-start space-x-2.5">
            <ShieldCheck className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <span className="text-xs font-bold text-amber-900 block">Proteção de Conferência Real</span>
              <span className="text-[10px] text-amber-800/80 leading-tight block mt-0.5">
                Mapas com contagem física real realizada por conferentes NÃO são sobrescritos.
              </span>
            </div>
          </div>

          <div className="bg-blue-50/60 border border-blue-200/80 rounded-xl p-3 flex items-start space-x-2.5">
            <UserPlus className="h-4 w-4 text-blue-600 shrink-0 mt-0.5" />
            <div>
              <span className="text-xs font-bold text-blue-900 block">Cadastro Automático de Motoristas</span>
              <span className="text-[10px] text-blue-800/80 leading-tight block mt-0.5">
                Motoristas não encontrados na base (ex: G50, G30) são cadastrados automaticamente.
              </span>
            </div>
          </div>

          <div className="bg-emerald-50/60 border border-emerald-200/80 rounded-xl p-3 flex items-start space-x-2.5">
            <FileCheck className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
            <div>
              <span className="text-xs font-bold text-emerald-900 block">Marcação Estimativa Histórica</span>
              <span className="text-[10px] text-emerald-800/80 leading-tight block mt-0.5">
                Cada documento recebe a flag <code className="font-mono bg-emerald-100 px-1 py-0.5 rounded">isEstimated: true</code> e entrada no histórico.
              </span>
            </div>
          </div>
        </div>

        {/* Import Trigger Buttons */}
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <input
            type="file"
            ref={refugoFileInputRef}
            onChange={handleRetroFileChange}
            accept=".xlsx,.xls,.csv,.json"
            className="hidden"
          />

          <button
            onClick={handleImportPreloadedRetroJson}
            disabled={isProcessingRetro || isImporting}
            className="bg-amber-500 hover:bg-amber-600 active:scale-98 text-slate-950 font-black text-xs px-5 py-3 rounded-xl flex items-center space-x-2 shadow-md shadow-amber-500/20 transition cursor-pointer"
          >
            {isProcessingRetro ? (
              <RefreshCw className="h-4 w-4 animate-spin text-slate-950" />
            ) : (
              <Sparkles className="h-4 w-4 text-slate-950" />
            )}
            <span>1. Carregar Dataset Oficial (audits_retroativos_import.json)</span>
          </button>

          <button
            onClick={() => refugoFileInputRef.current?.click()}
            disabled={isProcessingRetro || isImporting}
            className="bg-slate-900 hover:bg-slate-800 active:scale-98 text-white font-bold text-xs px-5 py-3 rounded-xl flex items-center space-x-2 border border-slate-900 shadow-xs transition cursor-pointer"
          >
            <FileSpreadsheet className="h-4 w-4 text-amber-400" />
            <span>2. Selecionar Planilha Excel (.xlsx, .csv) ou JSON</span>
          </button>
        </div>

        {/* Analytical Preview Panel when file is parsed */}
        {retroImportResult && (
          <div className="bg-slate-900 text-white rounded-xl p-5 space-y-4 border border-slate-800 animate-fade-in shadow-inner">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center space-x-2">
                <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                <h5 className="font-bold text-sm text-white">Análise Prévia do Dataset</h5>
              </div>
              <span className="text-xxs font-mono bg-emerald-950 text-emerald-400 border border-emerald-800 px-2.5 py-0.5 rounded-full font-bold">
                Pronto para Gravação
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
              <div className="bg-slate-800/80 p-3 rounded-lg border border-slate-700">
                <span className="text-[10px] font-bold text-slate-400 block uppercase">Total Mapas no Arquivo</span>
                <span className="text-lg font-mono font-black text-white mt-0.5 block">{retroImportResult.totalMapsProcessed}</span>
              </div>
              <div className="bg-slate-800/80 p-3 rounded-lg border border-slate-700">
                <span className="text-[10px] font-bold text-emerald-400 block uppercase">Auditorias a Gravar</span>
                <span className="text-lg font-mono font-black text-emerald-400 mt-0.5 block">{retroImportResult.auditsToSave.length}</span>
              </div>
              <div className="bg-slate-800/80 p-3 rounded-lg border border-slate-700">
                <span className="text-[10px] font-bold text-amber-400 block uppercase">Ignoradas (Conferência Real)</span>
                <span className="text-lg font-mono font-black text-amber-400 mt-0.5 block">{retroImportResult.skippedAuditsCount}</span>
              </div>
              <div className="bg-slate-800/80 p-3 rounded-lg border border-slate-700">
                <span className="text-[10px] font-bold text-blue-400 block uppercase">Novos Motoristas</span>
                <span className="text-lg font-mono font-black text-blue-400 mt-0.5 block">{retroImportResult.unregisteredDriversCount}</span>
              </div>
            </div>

            <div className="flex items-center justify-between pt-2">
              <button
                onClick={() => setRetroImportResult(null)}
                className="text-xs text-slate-400 hover:text-white underline font-medium cursor-pointer"
              >
                Cancelar Análise
              </button>
              <button
                onClick={handleConfirmSaveRetroAudits}
                disabled={isImporting}
                className="bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-black text-xs px-6 py-3 rounded-xl flex items-center space-x-2 shadow-md shadow-emerald-500/20 transition cursor-pointer"
              >
                {isImporting ? (
                  <RefreshCw className="h-4 w-4 animate-spin text-slate-950" />
                ) : (
                  <Upload className="h-4 w-4 text-slate-950" />
                )}
                <span>CONFIRMAR E SALVAR NO BANCO 01</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Modules Specific Exporters Grid */}
      <div className="space-y-4 pt-2">
        <div className="flex items-center space-x-2 pb-2 border-b border-slate-200">
          <Layers className="h-4 w-4 text-blue-600" />
          <h4 className="font-sans font-black text-xs text-slate-900 uppercase tracking-wider">
            Exportar Dados por Abas / Módulos Individuais
          </h4>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

          {/* 1. PAINEL GERENCIAL, MONITORAMENTO, SINCRONIZADOR & HISTÓRICOS */}
          <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3.5 shadow-2xs hover:border-blue-300 transition">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center space-x-3">
                <div className="p-2.5 bg-blue-50 text-blue-600 rounded-xl border border-blue-100">
                  <Box className="h-5 w-5" />
                </div>
                <div>
                  <h5 className="font-bold text-xs text-slate-900">1. PAINEL GERENCIAL, MONITORAMENTO, SINCRONIZADOR & HISTÓRICOS</h5>
                  <p className="text-xxs text-slate-500 mt-0.5">{importedRoutes.length} rotas importadas e históricos de viagens</p>
                </div>
              </div>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              Exporta todas as rotas processadas, placas, motoristas, conferentes atribuídos, horários de chegada e status de fechamento.
            </p>
            <div className="flex items-center space-x-2 pt-2 border-t border-slate-100">
              <button
                onClick={() => exportModuleData('Rotas e Históricos', importedRoutes, 'rotas_plataforma', 'json')}
                className="flex-1 py-2.5 px-3 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold rounded-xl flex items-center justify-center space-x-1.5 transition cursor-pointer"
              >
                <FileJson className="h-4 w-4 text-blue-600" />
                <span>Baixar JSON</span>
              </button>
              <button
                onClick={() => exportModuleData('Rotas e Históricos', importedRoutes, 'rotas_plataforma', 'csv')}
                className="flex-1 py-2.5 px-3 bg-emerald-50 hover:bg-emerald-100 text-emerald-900 text-xs font-bold rounded-xl flex items-center justify-center space-x-1.5 transition cursor-pointer border border-emerald-200"
              >
                <FileSpreadsheet className="h-4 w-4 text-emerald-600" />
                <span>Excel (CSV)</span>
              </button>
            </div>
          </div>

          {/* 2. CONTAGEM FÍSICA & CONCILIAÇÃO FISCAL */}
          <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3.5 shadow-2xs hover:border-amber-300 transition">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center space-x-3">
                <div className="p-2.5 bg-amber-50 text-amber-600 rounded-xl border border-amber-100">
                  <Table className="h-5 w-5" />
                </div>
                <div>
                  <h5 className="font-bold text-xs text-slate-900">2. CONTAGEM FÍSICA & CONCILIAÇÃO FISCAL</h5>
                  <p className="text-xxs text-slate-500 mt-0.5">{audits.length} auditorias físicas registradas</p>
                </div>
              </div>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              Exporta as aferições físicas dos conferentes (caixas PA, garrafas AG, garrafeiros), divergências físicas x fiscais e logs de releitura.
            </p>
            <div className="flex items-center space-x-2 pt-2 border-t border-slate-100">
              <button
                onClick={() => exportModuleData('Auditorias e Contagem Física', audits, 'auditorias_contagem_fisica', 'json')}
                className="flex-1 py-2.5 px-3 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold rounded-xl flex items-center justify-center space-x-1.5 transition cursor-pointer"
              >
                <FileJson className="h-4 w-4 text-amber-600" />
                <span>Baixar JSON</span>
              </button>
              <button
                onClick={() => exportModuleData('Auditorias e Contagem Física', audits, 'auditorias_contagem_fisica', 'csv')}
                className="flex-1 py-2.5 px-3 bg-emerald-50 hover:bg-emerald-100 text-emerald-900 text-xs font-bold rounded-xl flex items-center justify-center space-x-1.5 transition cursor-pointer border border-emerald-200"
              >
                <FileSpreadsheet className="h-4 w-4 text-emerald-600" />
                <span>Excel (CSV)</span>
              </button>
            </div>
          </div>

          {/* 3. SOBRAS E FALTAS PA/AG */}
          <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3.5 shadow-2xs hover:border-red-300 transition">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center space-x-3">
                <div className="p-2.5 bg-red-50 text-red-600 rounded-xl border border-red-100">
                  <AlertTriangle className="h-5 w-5" />
                </div>
                <div>
                  <h5 className="font-bold text-xs text-slate-900">3. SOBRAS & FALTAS PA/AG</h5>
                  <p className="text-xxs text-slate-500 mt-0.5">Alertas fiscais e relatórios de avarias</p>
                </div>
              </div>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              Exporta a lista de alertas de sobras e faltas de produtos, avarias identificadas e divergências fiscais enviadas ao acerto financeiro.
            </p>
            <div className="flex items-center space-x-2 pt-2 border-t border-slate-100">
              <button
                onClick={() => {
                  const divergentAudits = audits.filter(a => a.status === 'finalizado_divergente' || (a.items && a.items.some(i => i.physicalQty !== i.fiscalQty)));
                  exportModuleData('Sobras e Faltas', divergentAudits, 'sobras_e_faltas', 'json');
                }}
                className="flex-1 py-2.5 px-3 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold rounded-xl flex items-center justify-center space-x-1.5 transition cursor-pointer"
              >
                <FileJson className="h-4 w-4 text-red-600" />
                <span>Baixar JSON</span>
              </button>
              <button
                onClick={() => {
                  const divergentAudits = audits.filter(a => a.status === 'finalizado_divergente' || (a.items && a.items.some(i => i.physicalQty !== i.fiscalQty)));
                  exportModuleData('Sobras e Faltas', divergentAudits, 'sobras_e_faltas', 'csv');
                }}
                className="flex-1 py-2.5 px-3 bg-emerald-50 hover:bg-emerald-100 text-emerald-900 text-xs font-bold rounded-xl flex items-center justify-center space-x-1.5 transition cursor-pointer border border-emerald-200"
              >
                <FileSpreadsheet className="h-4 w-4 text-emerald-600" />
                <span>Excel (CSV)</span>
              </button>
            </div>
          </div>

          {/* 4. GESTÃO DE VALES */}
          <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3.5 shadow-2xs hover:border-indigo-300 transition">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center space-x-3">
                <div className="p-2.5 bg-indigo-50 text-indigo-600 rounded-xl border border-indigo-100">
                  <Ticket className="h-5 w-5" />
                </div>
                <div>
                  <h5 className="font-bold text-xs text-slate-900">4. GESTÃO DE VALES</h5>
                  <p className="text-xxs text-slate-500 mt-0.5">{vales.length} vales financeiros cadastrados</p>
                </div>
              </div>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              Exporta o histórico completo de vales emitidos para motoristas, valores, comprovantes, assinaturas e status de compensação financeira.
            </p>
            <div className="flex items-center space-x-2 pt-2 border-t border-slate-100">
              <button
                onClick={() => exportModuleData('Gestão de Vales', vales, 'vales_financeiros', 'json')}
                className="flex-1 py-2.5 px-3 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold rounded-xl flex items-center justify-center space-x-1.5 transition cursor-pointer"
              >
                <FileJson className="h-4 w-4 text-indigo-600" />
                <span>Baixar JSON</span>
              </button>
              <button
                onClick={() => exportModuleData('Gestão de Vales', vales, 'vales_financeiros', 'csv')}
                className="flex-1 py-2.5 px-3 bg-emerald-50 hover:bg-emerald-100 text-emerald-900 text-xs font-bold rounded-xl flex items-center justify-center space-x-1.5 transition cursor-pointer border border-emerald-200"
              >
                <FileSpreadsheet className="h-4 w-4 text-emerald-600" />
                <span>Excel (CSV)</span>
              </button>
            </div>
          </div>

          {/* 5. CADASTROS DA PLATAFORMA (USUÁRIOS, MOTORISTAS, VEÍCULOS, PRODUTOS) */}
          <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3.5 shadow-2xs hover:border-emerald-300 transition">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center space-x-3">
                <div className="p-2.5 bg-emerald-50 text-emerald-600 rounded-xl border border-emerald-100">
                  <Users className="h-5 w-5" />
                </div>
                <div>
                  <h5 className="font-bold text-xs text-slate-900">5. CADASTROS GERAIS DA PLATAFORMA</h5>
                  <p className="text-xxs text-slate-500 mt-0.5">{users.length} usuários | {drivers.length} motoristas | {products.length} produtos</p>
                </div>
              </div>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              Exporta os cadastros mestres de usuários do sistema, motoristas, frotas de veículos e tabela completa de produtos e embalagens.
            </p>
            <div className="flex items-center space-x-2 pt-2 border-t border-slate-100">
              <button
                onClick={() => {
                  const masterCadastros = { users, drivers, vehicles, products, activeAssets };
                  const jsonString = JSON.stringify(masterCadastros, null, 2);
                  downloadFile(`cadastros_gerais_${new Date().toISOString().split('T')[0]}.json`, jsonString, 'application/json');
                }}
                className="flex-1 py-2.5 px-3 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold rounded-xl flex items-center justify-center space-x-1.5 transition cursor-pointer"
              >
                <FileJson className="h-4 w-4 text-emerald-600" />
                <span>Baixar JSON</span>
              </button>
              <button
                onClick={() => exportModuleData('Produtos', products, 'produtos_cadastrados', 'csv')}
                className="flex-1 py-2.5 px-3 bg-emerald-50 hover:bg-emerald-100 text-emerald-900 text-xs font-bold rounded-xl flex items-center justify-center space-x-1.5 transition cursor-pointer border border-emerald-200"
              >
                <FileSpreadsheet className="h-4 w-4 text-emerald-600" />
                <span>Produtos (CSV)</span>
              </button>
            </div>
          </div>

          {/* 6. DADOS LOCAIS E CACHE (localStorage) */}
          <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3.5 shadow-2xs hover:border-purple-300 transition">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center space-x-3">
                <div className="p-2.5 bg-purple-50 text-purple-600 rounded-xl border border-purple-100">
                  <HardDrive className="h-5 w-5" />
                </div>
                <div>
                  <h5 className="font-bold text-xs text-slate-900">6. DADOS LOCAIS & MEMÓRIA DO NAVEGADOR</h5>
                  <p className="text-xxs text-slate-500 mt-0.5">localStorage e rascunhos em cache do cliente</p>
                </div>
              </div>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              Exporta todas as chaves e valores armazenados no navegador do cliente (rascunhos pendentes de sincronização e configurações de sessão).
            </p>
            <div className="flex items-center space-x-2 pt-2 border-t border-slate-100">
              <button
                onClick={() => {
                  const dump: Record<string, any> = {};
                  try {
                    for (let i = 0; i < localStorage.length; i++) {
                      const key = localStorage.key(i);
                      if (key) {
                        try {
                          dump[key] = JSON.parse(localStorage.getItem(key) || '""');
                        } catch {
                          dump[key] = localStorage.getItem(key);
                        }
                      }
                    }
                  } catch (e) {}
                  downloadFile(`dados_locais_cache_${new Date().toISOString().split('T')[0]}.json`, JSON.stringify(dump, null, 2), 'application/json');
                }}
                className="w-full py-2.5 px-3 bg-purple-50 hover:bg-purple-100 text-purple-900 text-xs font-bold rounded-xl flex items-center justify-center space-x-1.5 transition cursor-pointer border border-purple-200"
              >
                <FileJson className="h-4 w-4 text-purple-600" />
                <span>Baixar Cache Local (JSON)</span>
              </button>
            </div>

          </div>

        </div>
      </div>
    </div>
  );
}
