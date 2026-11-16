// Rough news categories from an announcement's subject and one-line summary. First match wins.
export const CATEGORIES = [
  ['result', /financial result|integrated filing- financial|outcome of board meeting.*result|results? for the (quarter|period)/i],
  ['order', /order|contract|award|letter of (award|intent)|\bLoA\b|\bLoI\b|bagged|secured|empanel/i],
  ['approval', /usfda|us fda|\bEIR\b|approval from|anda|drug|patent|license|licence/i],
  ['buyback', /buy ?back/i],
  ['bonus-split', /bonus|split|sub-division/i],
  ['dividend', /dividend/i],
  ['acquisition', /acqui|merger|amalgamation|takeover|stake|joint venture|\bJV\b|strategic/i],
  ['fundraise', /qip|preferential|rights issue|fund rais|warrants|ncd|debenture|allotment/i],
  ['rating', /credit rating|rating/i],
  ['management', /resign|appoint|cessation|director|ceo|cfo|managing/i],
  ['legal', /penalty|litigation|search|raid|show cause|sebi order|income tax|gst|fraud|default|insolvency/i],
  ['meeting', /analyst|investor meet|earnings call|conference call|press release|presentation/i],
];
export const categorise = (desc, text) => {
  const s = `${desc} ${text}`;
  for (const [c, re] of CATEGORIES) if (re.test(s)) return c;
  return 'other';
};
