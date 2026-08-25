// ============================================================
//  UPDATE GOALS — pulls current PL goal tallies from the
//  official Fantasy Premier League API and writes them into
//  data.js automatically.
//
//  This uses the free, public, unauthenticated FPL endpoint —
//  no API key needed, no request limits, always the current
//  season. Runs once a day via GitHub Actions (see
//  .github/workflows/update-goals.yml). You can also run it by
//  hand any time with:  node scripts/update-goals.js
//
//  Flags:
//    --dry-run   Fetch and print what WOULD change, but never
//                write to data.js. Safe to run any time.
// ============================================================

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const DATA_PATH = path.join(__dirname, '..', 'data.js');
const FPL_URL = 'https://fantasy.premierleague.com/api/bootstrap-static/';

function normalise(s) {
  return s
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[-_.]/g, ' ')       // hyphens/underscores/dots become spaces, not deleted
    .replace(/[^a-z0-9 ]/g, '')   // strip anything else (apostrophes etc.)
    .replace(/\s+/g, ' ')          // collapse any double spaces from the above
    .trim();
}

// Try to match an FPL player entry against one of your data.js player names.
// FPL gives us three name fields to try: web_name (short, e.g. "Saka"),
// and first_name + second_name (full name, e.g. "Bukayo Saka").
function findMatch(fplPlayer, ourNames) {
  const fullName = normalise(`${fplPlayer.first_name} ${fplPlayer.second_name}`);
  const webName = normalise(fplPlayer.web_name);

  // 1. Exact full name match
  let hit = ourNames.find(n => normalise(n) === fullName);
  if (hit) return hit;

  // 2. Exact web_name (short name) match
  hit = ourNames.find(n => normalise(n) === webName);
  if (hit) return hit;

  // 3. Our name contains or is contained by the full name
  hit = ourNames.find(n => {
    const nn = normalise(n);
    return nn.includes(fullName) || fullName.includes(nn);
  });
  if (hit) return hit;

  // 4. Our name contains or is contained by the web_name
  hit = ourNames.find(n => {
    const nn = normalise(n);
    return nn.includes(webName) || webName.includes(nn);
  });
  if (hit) return hit;

  // 5. Surname-only fallback (last word of full name)
  const surname = fullName.split(' ').pop();
  hit = ourNames.find(n => normalise(n).split(' ').pop() === surname);
  return hit || null;
}

async function main() {
  console.log('Fetching live Premier League data from FPL...');
  const res = await fetch(FPL_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; PLBlackjackBot/1.0)',
      'Accept': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`FPL API error ${res.status}`);
  const data = await res.json();

  const teamsById = {};
  data.teams.forEach(t => { teamsById[t.id] = t.short_name; });

  const dataSrc = fs.readFileSync(DATA_PATH, 'utf8');
  const { PLAYERS } = new Function(dataSrc + '\nreturn { PLAYERS };')();
  if (!PLAYERS) throw new Error('Could not read PLAYERS from data.js — aborting without writing.');

  const ourNames = PLAYERS.map(p => p.name);
  const goalUpdates = {};
  const unmatched = [];

  for (const el of data.elements) {
    const match = findMatch(el, ourNames);
    if (match) {
      // If the same person matches twice for any reason, keep the higher figure
      goalUpdates[match] = Math.max(goalUpdates[match] || 0, el.goals_scored || 0);
    }
  }

  for (const name of ourNames) {
    if (!(name in goalUpdates)) unmatched.push(name);
  }
  if (unmatched.length) {
    console.warn('\nCould not match these players against FPL data (left unchanged):');
    unmatched.forEach(n => console.warn('  - ' + n));
  }

  let newSrc = dataSrc;
  let changedCount = 0;
  const changes = [];
  for (const [name, goals] of Object.entries(goalUpdates)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(name:\\s*"${escaped}"[^}]*?goals:\\s*)(\\d+)`);
    const m = newSrc.match(re);
    if (m && parseInt(m[2], 10) !== goals) {
      changes.push({ name, from: parseInt(m[2], 10), to: goals });
      if (!DRY_RUN) {
        newSrc = newSrc.replace(re, `$1${goals}`);
      }
      changedCount++;
    }
  }

  const now = new Date().toLocaleString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London',
  });

  if (DRY_RUN) {
    console.log('\n========== DRY RUN — nothing written ==========');
    console.log(`Would update ${changedCount} player(s):`);
    changes.sort((a, b) => b.to - a.to).forEach(c => console.log(`  ${c.name}: ${c.from} → ${c.to}`));
    console.log(`\nWould set LAST_UPDATED to: ${now}`);
    console.log('\ndata.js was NOT modified. Re-run without --dry-run to apply for real.');
    return;
  }

  changes.forEach(c => console.log(`  ${c.name}: ${c.from} → ${c.to}`));

  newSrc = newSrc.replace(
    /const LAST_UPDATED = ".*?";/,
    `const LAST_UPDATED = "${now}";`
  );

  console.log(changedCount === 0
    ? '\nNo goal changes since last run. Updating timestamp only.'
    : `\n${changedCount} player(s) updated.`);

  fs.writeFileSync(DATA_PATH, newSrc);
  console.log('data.js written.');
}

main().catch(err => {
  console.error('Fatal error, data.js NOT modified:', err.message);
  process.exit(1);
});
