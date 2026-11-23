import type { ConnectLinkCopy } from "./en";

/** The connection-link landing page, in Spanish. */
export const es: ConnectLinkCopy = {
  lang: "es",
  pageTitle: "Conecta tu número de WhatsApp",
  summary: "Conecta el número que tu negocio usa en la app WhatsApp Business. Son unos 5 minutos.",
  loading: "Comprobando el enlace…",
  title: (workspace) => `Conecta tu número de WhatsApp a ${workspace}`,
  intro: (inviter) =>
    `${inviter} te ha pedido que conectes el número que tu negocio usa en la app WhatsApp Business. Seguirás usando la app en tu teléfono como siempre.`,
  beforeTitle: "Antes de empezar",
  before: ["Este ordenador y el teléfono, los dos a mano", "Una cuenta de Facebook (vale la tuya personal)", "Unos 5 minutos"],
  meta: "Meta abrirá una ventana, te pedirá que inicies sesión y mostrará un código QR para escanearlo con el teléfono. Tu número y tu cuenta de empresa de Meta siguen siendo tuyos.",
  button: "Conectar con Meta",
  preparing: "Preparando…",
  connecting: "Conectando…",
  connectedTitle: "Conectado.",
  connected: (phone, workspace) =>
    `${phone ?? "Tu número"} ya funciona con ${workspace}. No cambia nada en tu teléfono. Puedes cerrar esta página.`,
  leftOut: (inviter) =>
    `Algunos números se han quedado fuera: este espacio de trabajo no puede añadir números nuevos ahora mismo. Díselo a ${inviter}.`,
  pending: (inviter) =>
    `Tu cuenta de WhatsApp está conectada, pero el número aún no está listo. ${inviter} lo terminará. Puedes cerrar esta página.`,
  unknown: (inviter) =>
    `Estamos comprobando si tu número se ha conectado. ${inviter} te lo confirmará. No empieces de nuevo.`,
  busy: "Ya hay una conexión en curso con este enlace. Espera un minuto y empieza de nuevo.",
  notPrepared: "No se ha podido preparar la conexión. Cierra la ventana de Meta y empieza de nuevo.",
  cancelled: "No se ha conectado nada. Puedes empezar de nuevo con el mismo enlace.",
  gone: (inviter) => `Este enlace ya no funciona. Pide uno nuevo a ${inviter}.`,
  sender: "quien te lo envió",
  owned: (inviter) => `La cuenta de Meta de este número ya está conectada en otro sitio. Díselo a ${inviter}.`,
  noWaba: "Meta no ha compartido ninguna cuenta de WhatsApp. Empieza de nuevo y completa todos los pasos en la ventana de Meta.",
  closed: (inviter) => `Este espacio de trabajo no puede añadir números ahora mismo. Díselo a ${inviter}.`,
  failed: "No se ha podido completar la conexión. Empieza de nuevo con el mismo enlace.",
  attemptExpired: "Ese intento ha tardado demasiado. Empieza de nuevo con el mismo enlace.",
  popupBlocked: (host) =>
    `Tu navegador ha bloqueado la ventana de Meta. Permite las ventanas emergentes para ${host} y vuelve a pulsar.`,
  closeMeta: "Cierra la ventana de Meta y vuelve a intentarlo.",
  scriptBlocked: "No se ha cargado el script de Meta. Desactiva cualquier bloqueador en esta página y recárgala.",
  unavailable: (inviter) => `La conexión no está disponible ahora mismo. Díselo a ${inviter}.`,
  limited: "Demasiados intentos. Espera unos minutos y vuelve a abrir el enlace.",
  unreachable: "No se ha podido contactar con Eccos. Revisa tu conexión y recarga la página.",
};
