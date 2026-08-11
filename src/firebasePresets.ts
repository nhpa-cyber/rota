export interface FirebasePreset {
  id: string;
  name: string;
  badge: string;
  badgeColor: string;
  description: string;
  config: {
    projectId: string;
    appId: string;
    apiKey: string;
    authDomain: string;
    firestoreDatabaseId: string;
    storageBucket: string;
    messagingSenderId: string;
    measurementId?: string;
    oAuthClientId?: string;
  };
}

export const FIREBASE_PRESETS: FirebasePreset[] = [
  {
    id: "banco-03",
    name: "Banco 03 (Banco Principal - Plataforma Completa)",
    badge: "Banco 03 (Ativo)",
    badgeColor: "bg-indigo-500/15 text-indigo-600 border-indigo-500/30",
    description: "banco-03-6b1ea (Banco Único de Dados para Todos os Usuários)",
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

export function getActivePresetId(projectId?: string): string {
  return "banco-03";
}
