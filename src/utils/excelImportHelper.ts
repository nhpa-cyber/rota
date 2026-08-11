import * as XLSX from 'xlsx';
import { AuditSession, AuditRefugo, Driver } from '../types';

export interface ProcessImportResult {
  auditsToSave: AuditSession[];
  skippedAuditsCount: number;
  newDriversToSave: Driver[];
  unregisteredDriversCount: number;
  totalMapsProcessed: number;
}

// Normalizer for map codes (removes leading zeros, spaces)
function normalizeMapCode(mapCode: any): string {
  if (!mapCode) return '';
  const str = String(mapCode).trim();
  return str.replace(/^0+/, '') || str;
}

// Format dates YYYY-MM-DD
function formatDateToYYYYMMDD(val: any): string {
  if (!val) return new Date().toISOString().split('T')[0];

  // If Excel Date serial number
  if (typeof val === 'number') {
    const jsDate = new Date(Math.round((val - 25569) * 86400 * 1000));
    if (!isNaN(jsDate.getTime())) {
      return jsDate.toISOString().split('T')[0];
    }
  }

  const str = String(val).trim();

  // Pattern DD/MM/YYYY or DD-MM-YYYY
  if (str.includes('/') || str.includes('-')) {
    const parts = str.split(/[\/\-]/);
    if (parts.length === 3) {
      if (parts[0].length === 4) {
        // Already YYYY-MM-DD
        return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
      } else {
        // DD/MM/YYYY -> YYYY-MM-DD
        const day = parts[0].padStart(2, '0');
        const month = parts[1].padStart(2, '0');
        const year = parts[2];
        return `${year}-${month}-${day}`;
      }
    }
  }

  return new Date().toISOString().split('T')[0];
}

// Map column header names to standardized reason name in uppercase
function mapHeaderToReasonName(header: string): string | null {
  if (!header || typeof header !== 'string') return null;

  const norm = header.trim().toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // removes accents

  if (norm.includes('QUEBRADA')) return 'QUEBRADA';
  if (norm.includes('SEGUNDA')) return 'SEGUNDA (OUTRAS EMPRESAS)';
  if (norm.includes('BICADA INTERNA')) return 'BICADA INTERNA';
  if (norm.includes('BICADA EXTERNA')) return 'BICADA EXTERNA';
  if (norm.includes('COR FORA') || norm.includes('COLORACAO FORA') || norm.includes('COR FORA DO PADRAO')) return 'COLORAÇÃO FORA DO PADRÃO';
  if (norm.includes('FALTANTE')) return 'FALTANTE';
  if (norm.includes('LOGOMARCA')) return 'LOGOMARCA ESTRANHA';
  if (norm.includes('ROTULO')) return 'RÓTULO PLÁSTICO';
  if (norm.includes('SUJIDADE INTERNA')) return 'SUJIDADE INTERNA';
  if (norm.includes('SUJIDADE EXTERNA')) return 'SUJIDADE EXTERNA';
  if (norm.includes('TAMPADA')) return 'TAMPADA';
  if (norm.includes('TRINCADA')) return 'TRINCADA';

  return null;
}

// Positional reasons fallback (Columns K to V / index 10 to 21)
const POSITIONAL_REASONS = [
  'QUEBRADA',
  'SEGUNDA (OUTRAS EMPRESAS)',
  'BICADA INTERNA',
  'BICADA EXTERNA',
  'COLORAÇÃO FORA DO PADRÃO',
  'FALTANTE',
  'LOGOMARCA ESTRANHA',
  'RÓTULO PLÁSTICO',
  'SUJIDADE INTERNA',
  'SUJIDADE EXTERNA',
  'TAMPADA',
  'TRINCADA'
];

/**
 * Process Excel, CSV, or raw JSON rows into AuditSession documents following all business rules.
 */
export function processRefugoImportData(
  rows: any[],
  existingAudits: AuditSession[],
  existingDrivers: Driver[]
): ProcessImportResult {
  const mapGroups: Record<string, {
    routeMap: string;
    plate: string;
    driverId: string;
    driverName: string;
    arrivalDate: string;
    refugos: AuditRefugo[];
  }> = {};

  const existingDriverIds = new Set(existingDrivers.map(d => String(d.id).trim().toUpperCase()));
  const missingDriversMap: Record<string, Driver> = {};

  // 1. Group rows by MAPA
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx];
    if (!row || typeof row !== 'object') continue;

    let rawMapa = '';
    let rawPlate = '';
    let rawDriverId = '';
    let rawDriverName = '';
    let rawDate = '';
    let rawTipo = '';
    let rawAssetName = '';
    let rawAssetId = '';

    const reasonValuePairs: Array<{ reasonName: string; qty: number }> = [];

    // If row is an array or object with numeric keys, check positional indices first
    const isArrayLike = Array.isArray(row) || Object.keys(row).some(k => /^\d+$/.test(k));

    const rowKeys = Object.keys(row);

    for (const key of rowKeys) {
      const val = row[key];
      const keyUpper = key.trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

      // Named header checks
      if (keyUpper === 'MAPA' || keyUpper === 'ROUTE' || keyUpper === 'NRO MAPA' || keyUpper.includes('ROUTE_MAP')) {
        rawMapa = String(val || '');
      } else if (keyUpper === 'PLACA' || keyUpper === 'PLATE' || keyUpper === 'VEICULO') {
        rawPlate = String(val || '');
      } else if (keyUpper === 'COD MOTORISTA' || keyUpper === 'COD_MOTORISTA' || keyUpper === 'CODIGO MOTORISTA' || keyUpper === 'DRIVERID') {
        rawDriverId = String(val || '');
      } else if (keyUpper === 'NOME MOTORISTA' || keyUpper === 'NOME_MOTORISTA' || keyUpper === 'DRIVERNAME' || (keyUpper.includes('MOTORISTA') && !keyUpper.includes('COD'))) {
        rawDriverName = String(val || '');
      } else if (keyUpper === 'DATA' || keyUpper === 'DATE' || keyUpper.includes('CHEGADA')) {
        rawDate = String(val || '');
      } else if (keyUpper === 'TIPO' || keyUpper === 'TIPO GARRAFA' || keyUpper.includes('TIPO_GARRAFA')) {
        rawTipo = String(val || '');
      } else if (keyUpper === 'ATIVO' || keyUpper === 'GARRAFA' || keyUpper.includes('NOME_ATIVO')) {
        rawAssetName = String(val || '');
      } else if (keyUpper === 'ASSET ID' || keyUpper === 'ASSETID' || keyUpper === 'ASSET_ID' || keyUpper.includes('CODIGO ATIVO') || keyUpper.includes('ATIVO DE GIRO')) {
        rawAssetId = String(val || '');
      }

      // Check if this key is a reason column
      const reasonName = mapHeaderToReasonName(key);
      if (reasonName) {
        let numQty = 0;
        if (typeof val === 'number') {
          numQty = val;
        } else if (typeof val === 'string') {
          const parsed = parseFloat(val.replace(',', '.'));
          if (!isNaN(parsed)) numQty = parsed;
        }
        if (numQty > 0) {
          reasonValuePairs.push({ reasonName, qty: Math.round(numQty) });
        }
      }
    }

    // Positional fallback if named header fields weren't found
    if (isArrayLike) {
      if (!rawDate) rawDate = String(row[0] || row['0'] || '');
      if (!rawMapa) rawMapa = String(row[2] || row['2'] || '');
      if (!rawPlate) rawPlate = String(row[3] || row['3'] || '');
      if (!rawDriverId) rawDriverId = String(row[4] || row['4'] || '');
      if (!rawDriverName) rawDriverName = String(row[5] || row['5'] || '');
      if (!rawTipo) rawTipo = String(row[6] || row['6'] || '');
      if (!rawAssetName) rawAssetName = String(row[7] || row['7'] || '');
      if (!rawAssetId) rawAssetId = String(row[8] || row['8'] || '');

      // Positional reason columns check (Indices 10 to 21) if no reasons found yet
      if (reasonValuePairs.length === 0) {
        POSITIONAL_REASONS.forEach((rName, idx) => {
          const colIndex = 10 + idx;
          const val = row[colIndex] !== undefined ? row[colIndex] : row[String(colIndex)];
          if (val !== undefined && val !== null && val !== '') {
            let numQty = 0;
            if (typeof val === 'number') numQty = val;
            else if (typeof val === 'string') {
              const parsed = parseFloat(val.replace(',', '.'));
              if (!isNaN(parsed)) numQty = parsed;
            }
            if (numQty > 0) {
              reasonValuePairs.push({ reasonName: rName, qty: Math.round(numQty) });
            }
          }
        });
      }
    }

    const mapClean = normalizeMapCode(rawMapa);
    if (!mapClean) continue;

    const plateClean = rawPlate.trim().toUpperCase() || 'SEM PLACA';
    const driverIdClean = rawDriverId.trim() || 'DESCONHECIDO';
    const driverNameClean = rawDriverName.trim();
    const dateFormatted = formatDateToYYYYMMDD(rawDate);

    // Fallbacks for Asset ID and Asset Name based on Tipo / Ativo
    let assetIdClean = rawAssetId.trim();
    let assetNameClean = rawAssetName.trim();

    if (!assetIdClean || !assetNameClean) {
      const tipoStr = (rawTipo + ' ' + rawAssetName).toUpperCase();
      if (tipoStr.includes('300')) {
        assetIdClean = assetIdClean || '198214';
        assetNameClean = assetNameClean || 'GARRAFA 300ML (RET)';
      } else if (tipoStr.includes('600')) {
        assetIdClean = assetIdClean || '27983';
        assetNameClean = assetNameClean || 'GARRAFA 600 ÁMBAR (RET)';
      } else if (tipoStr.includes('1L') || tipoStr.includes('1 L') || tipoStr === '1') {
        assetIdClean = assetIdClean || '188006';
        assetNameClean = assetNameClean || 'GARRAFA 1L(RET)';
      } else {
        assetIdClean = assetIdClean || '198214';
        assetNameClean = assetNameClean || 'GARRAFA ATIVO DE GIRO';
      }
    }

    // Track missing driver
    if (driverIdClean && driverIdClean !== 'DESCONHECIDO') {
      const driverKey = driverIdClean.toUpperCase();
      if (!existingDriverIds.has(driverKey) && !missingDriversMap[driverKey]) {
        missingDriversMap[driverKey] = {
          id: driverIdClean,
          name: (driverNameClean && driverNameClean.toUpperCase() !== 'NÃO CADASTRADO') 
            ? driverNameClean 
            : `Motorista ${driverIdClean}`,
          role: 'MOTORISTA',
          cpf: '',
          isTemporary: true
        };
      }
    }

    if (!mapGroups[mapClean]) {
      mapGroups[mapClean] = {
        routeMap: mapClean,
        plate: plateClean,
        driverId: driverIdClean,
        driverName: driverNameClean,
        arrivalDate: dateFormatted,
        refugos: []
      };
    }

    // Add refugos
    for (const pair of reasonValuePairs) {
      mapGroups[mapClean].refugos.push({
        id: `ref_${assetIdClean}_${mapClean}_${mapGroups[mapClean].refugos.length + 1}`,
        assetId: assetIdClean,
        assetName: assetNameClean,
        reason: pair.reasonName,
        qty: pair.qty
      });
    }
  }

  // 2. Build AuditSession documents & apply Protection Rules
  const auditsToSave: AuditSession[] = [];
  let skippedAuditsCount = 0;
  const totalMapsProcessed = Object.keys(mapGroups).length;

  const existingMapToAuditMap: Record<string, AuditSession> = {};
  existingAudits.forEach(a => {
    const norm = normalizeMapCode(a.routeMap).toUpperCase();
    if (norm) existingMapToAuditMap[norm] = a;
  });

  const nowIso = new Date().toISOString();

  for (const [mapCode, group] of Object.entries(mapGroups)) {
    const normCode = mapCode.toUpperCase();
    const existing = existingMapToAuditMap[normCode];

    // Rule 1: DO NOT overwrite physical conferência audits (!isEstimated)
    if (existing && !existing.isEstimated) {
      skippedAuditsCount++;
      continue;
    }

    const auditDoc: AuditSession = {
      id: `aud_retro_${group.routeMap}`,
      routeMap: group.routeMap,
      plate: group.plate,
      driverId: group.driverId,
      arrivalKm: 0,
      arrivalDate: group.arrivalDate,
      status: 'finalizado_ok',
      isSuspended: false,
      reopeningRequested: false,
      financeiroCiente: false,
      isEstimated: true,
      refugos: group.refugos,
      history: [
        {
          action: "Importação Retroativa (Estimativa Média)",
          user: "Importação Automática",
          timestamp: nowIso,
          details: "Valores estimados a partir da média histórica da planilha Promax. NÃO é uma contagem física real."
        }
      ],
      items: [],
      assets: []
    };

    auditsToSave.push(auditDoc);
  }

  const newDriversToSave = Object.values(missingDriversMap);

  return {
    auditsToSave,
    skippedAuditsCount,
    newDriversToSave,
    unregisteredDriversCount: newDriversToSave.length,
    totalMapsProcessed
  };
}

// Helper to split CSV line respecting quotes
function splitCsvLine(line: string, sep: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === sep && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

/**
 * Parses File (.xlsx, .xls, .csv, .json) and returns ProcessImportResult
 */
export async function parseAndProcessFile(
  file: File,
  existingAudits: AuditSession[],
  existingDrivers: Driver[]
): Promise<ProcessImportResult> {
  const fileNameLower = file.name.toLowerCase();

  // If JSON file
  if (fileNameLower.endsWith('.json')) {
    const text = await file.text();
    const parsed = JSON.parse(text);

    let auditsList: any[] = [];
    if (parsed.collections?.audits && Array.isArray(parsed.collections.audits)) {
      auditsList = parsed.collections.audits;
    } else if (parsed.audits && Array.isArray(parsed.audits)) {
      auditsList = parsed.audits;
    } else if (Array.isArray(parsed)) {
      auditsList = parsed;
    }

    if (auditsList.length > 0 && auditsList[0].refugos) {
      // It's already JSON audit docs
      const auditsToSave: AuditSession[] = [];
      let skippedAuditsCount = 0;
      const existingMapMap: Record<string, AuditSession> = {};
      existingAudits.forEach(a => {
        const norm = normalizeMapCode(a.routeMap).toUpperCase();
        if (norm) existingMapMap[norm] = a;
      });

      const existingDriverIds = new Set(existingDrivers.map(d => String(d.id).trim().toUpperCase()));
      const missingDriversMap: Record<string, Driver> = {};
      const nowIso = new Date().toISOString();

      for (const rawAudit of auditsList) {
        const mapClean = normalizeMapCode(rawAudit.routeMap || rawAudit.mapa || '');
        if (!mapClean) continue;

        const normMap = mapClean.toUpperCase();
        const existing = existingMapMap[normMap];

        // Rule 1: Protection against overwriting real physical audits
        if (existing && !existing.isEstimated) {
          skippedAuditsCount++;
          continue;
        }

        const driverIdClean = String(rawAudit.driverId || 'DESCONHECIDO').trim();

        // Track missing driver
        if (driverIdClean && driverIdClean !== 'DESCONHECIDO') {
          const driverKey = driverIdClean.toUpperCase();
          if (!existingDriverIds.has(driverKey) && !missingDriversMap[driverKey]) {
            missingDriversMap[driverKey] = {
              id: driverIdClean,
              name: `Motorista ${driverIdClean}`,
              role: 'MOTORISTA',
              cpf: '',
              isTemporary: true
            };
          }
        }

        const doc: AuditSession = {
          id: rawAudit.id || `aud_retro_${mapClean}`,
          routeMap: mapClean,
          plate: String(rawAudit.plate || 'SEM PLACA').trim().toUpperCase(),
          driverId: driverIdClean,
          arrivalKm: rawAudit.arrivalKm || 0,
          arrivalDate: formatDateToYYYYMMDD(rawAudit.arrivalDate || rawAudit.data),
          status: 'finalizado_ok',
          isSuspended: false,
          reopeningRequested: false,
          financeiroCiente: false,
          isEstimated: true,
          refugos: Array.isArray(rawAudit.refugos) ? rawAudit.refugos : [],
          history: Array.isArray(rawAudit.history) && rawAudit.history.length > 0 ? rawAudit.history : [
            {
              action: "Importação Retroativa (Estimativa Média)",
              user: "Importação Automática",
              timestamp: nowIso,
              details: "Valores estimados a partir da média histórica da planilha Promax. NÃO é uma contagem física real."
            }
          ],
          items: Array.isArray(rawAudit.items) ? rawAudit.items : [],
          assets: Array.isArray(rawAudit.assets) ? rawAudit.assets : []
        };

        auditsToSave.push(doc);
      }

      const newDrivers = Object.values(missingDriversMap);
      return {
        auditsToSave,
        skippedAuditsCount,
        newDriversToSave: newDrivers,
        unregisteredDriversCount: newDrivers.length,
        totalMapsProcessed: auditsList.length
      };
    } else {
      // JSON array of flat rows
      return processRefugoImportData(Array.isArray(parsed) ? parsed : [parsed], existingAudits, existingDrivers);
    }
  }

  // If XLSX, XLS or CSV
  const arrayBuffer = await file.arrayBuffer();
  let workbook: XLSX.WorkBook;

  try {
    workbook = XLSX.read(arrayBuffer, { type: 'array' });
  } catch (err) {
    const text = new TextDecoder('utf-8').decode(arrayBuffer);
    workbook = XLSX.read(text, { type: 'string' });
  }

  const sheetName = workbook.SheetNames.find(s => s.toLowerCase().includes('refugo')) || workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];

  // Convert worksheet to a 2D matrix (header: 1)
  let matrix = XLSX.utils.sheet_to_json<any[]>(worksheet, { header: 1, defval: '' });

  if (!matrix || matrix.length === 0) {
    return processRefugoImportData([], existingAudits, existingDrivers);
  }

  // Check if matrix rows have unsplit CSV lines (e.g. single cell string containing ';')
  const processedMatrix: any[][] = [];
  for (const row of matrix) {
    if (Array.isArray(row) && row.length === 1 && typeof row[0] === 'string' && row[0].includes(';')) {
      processedMatrix.push(splitCsvLine(row[0], ';'));
    } else if (Array.isArray(row) && row.length === 1 && typeof row[0] === 'string' && row[0].includes(',')) {
      processedMatrix.push(splitCsvLine(row[0], ','));
    } else if (Array.isArray(row)) {
      processedMatrix.push(row);
    }
  }
  matrix = processedMatrix;

  // Find the real header row (search first 20 rows for keywords like "MAPA", "PLACA", "COD MOTORISTA", "DATA", "QUEBRADA")
  let headerRowIndex = -1;
  for (let i = 0; i < Math.min(20, matrix.length); i++) {
    const row = matrix[i];
    if (!Array.isArray(row)) continue;
    const rowStr = row.map(cell => String(cell || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')).join(' ');
    if (rowStr.includes('MAPA') || rowStr.includes('ROUTE') || (rowStr.includes('PLACA') && rowStr.includes('MOTORISTA'))) {
      headerRowIndex = i;
      break;
    }
  }

  if (headerRowIndex === -1) {
    headerRowIndex = 0; // fallback to row 0
  }

  const headers = (matrix[headerRowIndex] || []).map(h => String(h || '').trim());

  const rowsOfObjects: any[] = [];

  // Convert matrix rows after headerRowIndex into objects/arrays
  for (let r = headerRowIndex + 1; r < matrix.length; r++) {
    const rowArray = matrix[r];
    if (!Array.isArray(rowArray) || rowArray.every(cell => cell === '' || cell === null || cell === undefined)) {
      continue;
    }

    const obj: Record<string, any> = {};
    let hasData = false;

    headers.forEach((h, cIdx) => {
      const cellVal = rowArray[cIdx];
      if (h) {
        obj[h] = cellVal !== undefined ? cellVal : '';
      }
      // Also attach positional numeric index as property so positional fallback works
      obj[cIdx] = cellVal !== undefined ? cellVal : '';
      if (cellVal !== '' && cellVal !== null && cellVal !== undefined) {
        hasData = true;
      }
    });

    if (hasData) {
      rowsOfObjects.push(obj);
    }
  }

  return processRefugoImportData(rowsOfObjects, existingAudits, existingDrivers);
}
