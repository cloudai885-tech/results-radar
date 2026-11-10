// Upcoming IPOs with grey market premium (GMP) and a simple score.
// GMP is an unofficial market, and the score weights are judgement, so the app shows
// how the score did on recent listings next to it.
import { ipoPage } from './sources.mjs';

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const scale = (v, lo, hi) => Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
const num = (s) => { const v = parseFloat(String(s ?? '').replace(/[,₹]/g, '')); return Number.isFinite(v) ? v : null; };
const text = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&#8377;/g, '₹').replace(/&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// The site shows "29-Oct" with no year, so use the year that puts it closest to today.
function dateFrom(cell, todayIso) {
  const m = /(\d{1,2})-([A-Z][a-z]{2})/.exec(cell);
  if (!m || !(m[2] in MONTHS)) return null;
  const year = Number(todayIso.slice(0, 4));
  const today = Date.parse(todayIso);
  const nearest = [year - 1, year, year + 1].map((y) => Date.UTC(y, MONTHS[m[2]], Number(m[1]))).sort((a, b) => Math.abs(a - today) - Math.abs(b - today))[0];
  return new Date(nearest).toISOString().slice(0, 10);
}

export function parseIpoTable(html, todayIso) {
  const start = html.indexOf('<table');
  const table = html.slice(start, html.indexOf('</table>', start));
  const rows = [];
  for (const r of table.matchAll(/<tr[\s\S]*?<\/tr>/g)) {
    const cells = [...r[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
    if (cells.length < 12) continue;
    const name = /<a [^>]*title="([^"]+)"/.exec(cells[0])?.[1];
    if (!name) continue;
    const nameText = text(cells[0]);
    const gmpText = text(cells[1]);
    const price = num(text(cells[4]));
    const closeGmp = /GMP:\s*(-?[\d.]+)/.exec(text(cells[8]))?.[1];
    const listed = /protected\]\s*\((-?[\d.]+)%\)/.exec(nameText);
    const range = /(-?[\d.]+)\s*↓\s*\/\s*(-?[\d.]+)\s*↑/.exec(gmpText);
    const gmpMatch = /₹\s*(-?[\d.]+)\s*\((-?[\d.]+)%\)/.exec(gmpText);
    rows.push({
      name,
      board: /SME/.test(/badge[^>]*>([^<]+)</.exec(cells[0])?.[1] ?? '') ? 'SME' : 'Mainboard',
      price,
      lot: num(text(cells[6])),
      sizeCr: num(text(cells[5]).replace(/Cr/, '')),
      gmp: gmpMatch ? Number(gmpMatch[1]) : null,
      gmpPct: gmpMatch ? Number(gmpMatch[2]) / 100 : null,
      gmpHigh: range ? Number(range[2]) : null,
      subscription: num(/([\d.,]+)x/.exec(text(cells[3]))?.[1]),
      open: dateFrom(text(cells[7]), todayIso),
      close: dateFrom(text(cells[8]), todayIso),
      listing: dateFrom(text(cells[10]), todayIso),
      listingGain: listed ? Number(listed[1]) / 100 : null,
      closeGmpPct: closeGmp != null && price ? Number(closeGmp) / price : null,
    });
  }
  return rows;
}

export function scoreIpo({ gmp, gmpPct, gmpHigh, subscription, board }) {
  if (gmpPct == null || !gmp) return { score: null, label: 'No GMP yet' };
  const parts = {
    premium: 50 * scale(gmpPct, 0, 0.4),
    demand: 25 * (subscription == null ? 0.5 : scale(Math.log10(Math.max(subscription, 0.01)), 0, 2)), // 1x = none, 100x = full
    holding: 10 * (gmpHigh > 0 ? scale(gmp / gmpHigh, 0.4, 1) : 0), // a GMP far below its peak is fading
    board: 15 * (board === 'Mainboard' ? 1 : 0.3), // SME issues are smaller and harder to sell
  };
  const score = Math.round(Object.values(parts).reduce((s, x) => s + x, 0));
  return { score, label: score >= 70 ? 'Strong' : score >= 45 ? 'Okay' : 'Avoid' };
}

function why(r, label) {
  const pct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
  if (label === 'No GMP yet') return 'There is no grey market price right now, so there is nothing to judge.';
  const demand = r.subscription == null ? 'Bids have not started.' : r.subscription >= 50 ? `Very strong demand at ${r.subscription}x.` : r.subscription >= 5 ? `Decent demand at ${r.subscription}x.` : `Weak demand at ${r.subscription}x.`;
  const fading = r.gmpHigh > 0 && r.gmp / r.gmpHigh < 0.6 ? ` GMP has dropped from its peak of ₹${r.gmpHigh}.` : '';
  const risk = r.board === 'SME' ? ' SME issue, so it is riskier and harder to sell.' : '';
  return `GMP suggests ${pct(r.gmpPct)} at listing. ${demand}${fading}${risk}`;
}

function statusOf(r, todayIso) {
  if (r.open && r.open > todayIso) return 'upcoming';
  if (r.close && r.close >= todayIso) return 'open';
  return 'closed';
}

export function buildIpoReport(html, todayIso) {
  const rows = parseIpoTable(html, todayIso);
  if (!rows.length) throw new Error('IPO table was empty');
  const items = rows
    .filter((r) => r.listingGain == null && (!r.listing || r.listing >= todayIso))
    .map((r) => { const s = scoreIpo(r); return { ...r, ...s, status: statusOf(r, todayIso), why: why(r, s.label) }; })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  // Recent listings, scored with the GMP from the day the issue closed.
  const record = {};
  for (const r of rows.filter((x) => x.listingGain != null && x.closeGmpPct != null)) {
    const { label } = scoreIpo({ ...r, gmp: r.closeGmpPct * r.price, gmpPct: r.closeGmpPct });
    (record[label] ??= []).push(r.listingGain);
  }
  const summary = Object.fromEntries(Object.entries(record).map(([label, g]) => [label, {
    count: g.length, avgGain: g.reduce((s, x) => s + x, 0) / g.length, positive: g.filter((x) => x > 0).length,
  }]));
  return { items, record: summary };
}

export const ipoReport = async (todayIso) => buildIpoReport(await ipoPage(), todayIso);
