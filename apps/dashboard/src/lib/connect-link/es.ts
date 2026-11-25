import type { ConnectLinkCopy } from "./en";

const PAGE_LINKED = {
  title: "Una página de Facebook está vinculada a este número",
  body: "En Meta Business Suite, quítala en Configuración, Cuentas, Páginas y vuelve a este mismo enlace.",
};
const NOT_FROM_APP = {
  title: "Este enlace no puede conectar tu número",
  body: "No depende de ti. Copia el error de abajo y envíaselo a quien te envió el enlace.",
};

const signupErrors: ConnectLinkCopy["signupErrors"] = {
  "3441067": {
    title: "Otro porfolio empresarial tiene este número",
    body: "Suele ser tu proveedor de WhatsApp anterior. Pide que libere el número y vuelve a este mismo enlace.",
  },
  "3441069": {
    title: "Este número está en la app normal de WhatsApp",
    body: "Pásalo a la app WhatsApp Business y vuelve a este mismo enlace.",
  },
  "3441070": NOT_FROM_APP,
  "3441072": NOT_FROM_APP,
  "3441090": {
    title: "Otra cuenta de tu porfolio tiene este número",
    body: "Quítalo de esa cuenta en el Administrador de WhatsApp y vuelve a este mismo enlace.",
  },
  "3441071": {
    title: "Tu cuenta de Facebook necesita autenticación en dos pasos",
    body: "La exige el porfolio de este número. Actívala en la configuración de seguridad de Facebook y vuelve a este mismo enlace.",
  },
  "3441075": {
    title: "Este número tiene activada la verificación en dos pasos",
    body: "Es el PIN de WhatsApp del número, no el acceso a tu cuenta de Facebook. Desactívalo y vuelve a este mismo enlace.",
  },
  "2655145": {
    title: "Meta ha restringido tu cuenta de Facebook",
    body: "Revisa la restricción en Business Support Home de Meta o pide a otra persona de tu negocio que abra este enlace.",
  },
  "2655123": PAGE_LINKED,
  "2655082": PAGE_LINKED,
  "3441093": {
    title: "Este número aún se está desconectando",
    body: "Puede tardar desde unos minutos hasta más de un día. Vuelve a este mismo enlace más tarde.",
  },
  "2494064": {
    title: "Este número está registrado en otro servicio de WhatsApp",
    body: "Suele ser otro proveedor de WhatsApp. Pide que lo liberen y vuelve a este mismo enlace.",
  },
};

/** The connection-link landing page, in Spanish. */
export const es: ConnectLinkCopy = {
  lang: "es",
  pageTitle: "Conecta tu número de WhatsApp",
  summary: "Conecta el número que tu negocio usa en la app WhatsApp Business. Son unos 5 minutos.",
  loading: "Comprobando el enlace…",
  intro: [" te pide conectar a ", " el número de tu app WhatsApp Business. La app seguirá funcionando igual."],
  beforeTitle: "Necesitas",
  before: ["Ábrelo en un ordenador, con el teléfono a mano para escanear un código QR", "Una cuenta de Facebook (vale la tuya personal)"],
  release: {
    lead: "¿Has usado este número con otro proveedor de WhatsApp?",
    rest: "Pide que lo liberen antes.",
  },
  button: "Conectar con Meta",
  ownership: "Tu número y tu cuenta de Meta siguen siendo tuyos.",
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
  signupErrors,
  unknownError: "Meta no ha conectado el número",
  notConnected: "No conectado",
  reported: (code, session) => (session ? `Error de Meta ${code} · sesión ${session}` : `Error de Meta ${code}`),
  copyLabels: { copy: "Copiar", copied: "Copiado", failed: "No se ha copiado" },
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
