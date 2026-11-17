// News types shared by steps 12 and 13: finer than categories.mjs, routine filings marked so they can be ignored.
export const TYPES = [
  ['routine', /newspaper|trading window|loss of share|duplicate share|certificate under reg|reg(ulation)?\.? ?74|74 ?\(5\)|shareholding pattern|closure of|record date|compliance certificate|investor complaints|book closure|esop|esos|change in (registrar|address)|postal ballot|scrutini[sz]er|voting results|annual report|\bagm\b|transcript|audio recording|video recording|recording of|takeover\)|reg(ulation)? 29|regulation 31|insider trading|statement of deviation|monitoring agency|secretarial|copy of|spurt in volume|price movement|clarification/i],
  ['result', /financial result|integrated filing- financial|results? for the (quarter|period|year)/i],
  ['legal', /penalty|litigation|\bsearch\b|raid|show cause|sebi order|orders? passed|action\(s\) (taken|initiated)|ordered to|demand notice|income tax|\btax\b|\bgst\b|fraud|default|insolvency|nclt|court|tribunal|arbitra/i],
  ['order', /order|contract|letter of (award|intent|acceptance)|\bLoA\b|\bLoI\b|bagged|secured|award|empanel|tender|L1 bidder|lowest bidder/i],
  ['approval', /usfda|us fda|\bEIR\b|\banda\b|approval|patent|licen[cs]e|clearance|inspection/i],
  ['deal', /acqui|merger|amalgamation|takeover|joint venture|\bJV\b|strategic|partnership|collaborat|\bmou\b|memorandum/i],
  ['corporate', /buy ?back|bonus|split|sub-division|dividend|delisting|open offer|demerger/i],
  ['capacity', /commission|capacity|plant|expansion|launch|new product|commercial (production|operation)/i],
  ['fundraise', /\bqip\b|preferential|rights issue|fund rais|warrants|\bncd\b|debenture|allotment|\bipo\b/i],
  ['rating', /credit rating|rating/i],
  ['management', /appoint|director|\bceo\b|\bcfo\b|managing|chairman|key managerial|resign|cessation/i],
  ['meeting', /analyst|investor meet|institutional investor|earnings call|conference call|presentation/i],
  ['press', /press release|media release|business update|\bupdate\b/i],
  ['board-meet', /board meeting|outcome of board/i],
];
export const typeOf = (desc, text) => { const s = `${desc} ${text}`; for (const [t, re] of TYPES) if (re.test(s)) return t; return 'other'; };
export const STRONG = ['result', 'order', 'approval', 'deal', 'corporate', 'capacity', 'fundraise', 'press', 'board-meet', 'other', 'meeting', 'rating', 'management', 'legal'];

