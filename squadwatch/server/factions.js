'use strict';
// server/factions.js — deployable classification + faction/team matching (SPEC §8).
// Pure functions, no I/O. Never guess: anything unclassifiable is null / -1 ("unknown").

// Known faction tokens, longest first (§8). Matched against `_`-separated
// className parts, scanning from the suffix toward the front.
const FACTION_TOKENS = [
  'PLANMC', 'PLAAGF', 'USMC', 'WPMC',
  'PLA', 'VDV', 'RGF', 'RUS', 'USA', 'BAF', 'CAF', 'AUS', 'ADF',
  'MEA', 'INS', 'IMF', 'MIL', 'TLF',
  'US', 'GB',
];
const FACTION_SET = new Set(FACTION_TOKENS);

// Generic skin suffixes that carry no faction information → null (§8).
const GENERIC_TOKENS = new Set(['WOODLAND', 'DESERT']);

// Alias map (§8): team setup strings and deployable class names disagree on
// a few faction spellings; both sides normalize through this before comparing.
const FACTION_ALIAS = { RUS: 'RGF', US: 'USA', GB: 'BAF' };
// Reverse lookup: canonical token → other tokens that normalize to it.
const ALIASES_OF = { RGF: ['RUS'], USA: ['US'], BAF: ['GB'] };

function normalizeFactionToken(token) {
  if (token == null) return null;
  const u = String(token).trim().toUpperCase();
  if (!u) return null;
  return FACTION_ALIAS[u] || u;
}

// classifyDeployable('BP_FOBRadio_Woodland_C_2146067116') →
//   { category: 'radio', factionToken: null, label: 'FOB Radio Woodland' }
function classifyDeployable(className) {
  const cls = String(className == null ? '' : className).trim();
  // Strip the UE class/instance suffix: "_C" or "_C_2146067116".
  const base = cls.replace(/_C(?:_\d+)?$/, '');

  let category = 'other';
  if (/FOBRadio|FOB_Radio/i.test(base)) category = 'radio';
  else if (/\bHAB\b|_Hab_|Hab$|HideoutHab|Bunker_Hab/i.test(base)) category = 'hab';

  let factionToken = null;
  const parts = base.split('_').filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const u = parts[i].toUpperCase();
    if (GENERIC_TOKENS.has(u)) continue; // Woodland/Desert are skins, not factions
    if (FACTION_SET.has(u)) { factionToken = u; break; }
  }

  let label = base
    .replace(/^BP_/, '')
    .replace(/_/g, ' ')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  if (!label) label = cls;

  return { category, factionToken, label };
}

// teamFactionTokens('USA_S_CombinedArms') → ['USA', 'US']
// teamFactionTokens('RUS_S_CombinedArms') → ['RGF', 'RUS']
// Returns the tokens that identify this team's faction: canonical token first,
// then any aliases that normalize to it. Empty/invalid input → [].
function teamFactionTokens(teamStr) {
  const s = String(teamStr == null ? '' : teamStr).trim();
  if (!s) return [];
  const lead = s.split('_')[0].trim();
  if (!lead) return [];
  const canonical = normalizeFactionToken(lead);
  if (!canonical) return [];
  const out = [canonical];
  for (const alias of ALIASES_OF[canonical] || []) {
    if (!out.includes(alias)) out.push(alias);
  }
  return out;
}

// resolveFriendly(depFactionToken, instigatorTeamId, match) → 1 | 0 | -1
//   1  = deployable belongs to the instigator's own team (friendly damage!)
//   0  = deployable belongs to the other team (legit enemy damage)
//   -1 = unknown (no token, unknown team, or token matches neither setup string)
// `match` holds the team setup strings: { team1, team2 } (e.g. 'USA_S_CombinedArms').
function resolveFriendly(depFactionToken, instigatorTeamId, match) {
  const dep = normalizeFactionToken(depFactionToken);
  if (!dep) return -1;
  if (!match || typeof match !== 'object') return -1;
  const teamId = Number(instigatorTeamId);
  if (teamId !== 1 && teamId !== 2) return -1;
  const ownStr = teamId === 1 ? match.team1 : match.team2;
  const otherStr = teamId === 1 ? match.team2 : match.team1;
  const own = teamFactionTokens(ownStr)[0] || null;
  const other = teamFactionTokens(otherStr)[0] || null;
  if (own && dep === own) return 1;
  if (other && dep === other) return 0;
  return -1;
}

module.exports = {
  classifyDeployable,
  teamFactionTokens,
  resolveFriendly,
  normalizeFactionToken,
};
