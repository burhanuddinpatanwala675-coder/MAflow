#!/usr/bin/env node
/**
 * generate-rules.js
 *
 * Regenerates the two hand-maintained copies of the role/permission matrix
 * FROM role-permissions.json, so they can never silently drift apart:
 *   - ROLE_PERMS in index.html          (drives the UI — hides tabs/buttons)
 *   - roleCanWrite() in firestore.rules (the copy that's actually enforced)
 *
 * This is deliberately a small, dependency-free Node script — not a bundler,
 * not a framework. index.html and firestore.rules stay plain, deployable
 * files; this just keeps one section of each in sync with one JSON file.
 *
 * Usage:
 *   node generate-rules.js            # regenerate both files in place
 *   node generate-rules.js --check    # exit 1 if either file is out of sync
 *                                      (wire this into CI / pre-deploy)
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'role-permissions.json');
const HTML_PATH = path.join(ROOT, 'index.html');
const RULES_PATH = path.join(ROOT, 'firestore.rules');

const HTML_START = '/* ROLE_PERMS:START */';
const HTML_END = '/* ROLE_PERMS:END */';
const RULES_START = '/* ROLE_MATRIX:START */';
const RULES_END = '/* ROLE_MATRIX:END */';
const HTML_PLAN_START = '/* PLAN_LIMITS:START */';
const HTML_PLAN_END = '/* PLAN_LIMITS:END */';
const RULES_PLAN_START = '/* PLAN_MATRIX:START */';
const RULES_PLAN_END = '/* PLAN_MATRIX:END */';

const checkOnly = process.argv.includes('--check');

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

function replaceBetween(content, startMarker, endMarker, newInner, fileLabel) {
  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(
      `Could not find markers ${startMarker} / ${endMarker} in ${fileLabel}. ` +
      `Has the file been restructured? Re-add the markers by hand once, then this script can maintain them.`
    );
  }
  const before = content.slice(0, startIdx + startMarker.length);
  const after = content.slice(endIdx);
  return `${before}\n${newInner}\n${after}`;
}

// ── build the ROLE_PERMS JS object literal (index.html) ──────────────────
function buildRolePermsJs(config) {
  const lines = Object.entries(config.roles).map(([role, perms]) => {
    const inner = Object.entries(perms)
      .map(([k, v]) => `'${k}':'${v}'`)
      .join(',');
    return `  ${role}:{${inner}},`;
  });
  // drop trailing comma on the last line for tidiness (optional in JS, but matches existing style)
  lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '');
  return `const ROLE_PERMS={\n${lines.join('\n')}\n};`;
}

// ── build the roleCanWrite() Firestore rules function ─────────────────────
function buildRoleCanWriteRules(config) {
  const { moduleToCollections, roles } = config;

  function collectionsForRole(roleName) {
    const perms = roles[roleName];
    const cols = new Set();
    Object.entries(perms).forEach(([moduleKey, access]) => {
      if (access !== 'w') return;
      const mapped = moduleToCollections[moduleKey];
      if (mapped) mapped.forEach((c) => cols.add(c));
    });
    return [...cols];
  }

  const nonAdminRoles = Object.keys(roles).filter((r) => r !== 'owner' && r !== 'admin');
  const clauses = nonAdminRoles
    .map((role) => {
      const cols = collectionsForRole(role);
      if (!cols.length) return null; // e.g. viewer — no write access at all, no clause needed
      const colList = cols.map((c) => `'${c}'`).join(',');
      return `        || (role == '${role}' && collectionId in [${colList}])`;
    })
    .filter(Boolean)
    .join('\n');

  return [
    'function roleCanWrite(companyId, collectionId) {',
    '  let role = memberRole(companyId);',
    "  return role in ['owner','admin']",
    clauses ? clauses + ';' : '    ;',
    '}',
  ].join('\n');
}

// ── build the PLAN_LIMITS JS object literal (index.html) ─────────────────
function buildPlanLimitsJs(config) {
  const planLimits = config.planLimits || {};
  const lines = Object.entries(planLimits).map(([plan, limits]) => {
    const blocked = (limits.blockedModules || []).map((m) => `'${m}'`).join(',');
    return `  ${plan}:{maxMembers:${limits.maxMembers},blockedModules:[${blocked}]},`;
  });
  lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '');
  return `const PLAN_LIMITS={\n${lines.join('\n')}\n};`;
}

// ── build the planAllowsCollection() Firestore rules function ────────────
function buildPlanAllowsCollectionRules(config) {
  const { moduleToCollections, planLimits } = config;
  // Only plans with at least one blocked module need a clause; others are unrestricted.
  const clauses = Object.entries(planLimits || {})
    .filter(([, limits]) => (limits.blockedModules || []).length > 0)
    .map(([plan, limits]) => {
      const cols = new Set();
      limits.blockedModules.forEach((moduleKey) => {
        const mapped = moduleToCollections[moduleKey];
        if (mapped) mapped.forEach((c) => cols.add(c));
      });
      const colList = [...cols].map((c) => `'${c}'`).join(',');
      return `plan == '${plan}' && collectionId in [${colList}]`;
    });

  const condition = clauses.length ? clauses.join(' || ') : 'false';
  return [
    'function planAllowsCollection(companyId, collectionId) {',
    '  let plan = companyDoc(companyId).data.plan;',
    `  return !(${condition});`,
    '}',
  ].join('\n');
}

function main() {
  const config = loadConfig();

  const newHtmlInner = buildRolePermsJs(config);
  const newRulesInner = '    ' + buildRoleCanWriteRules(config).split('\n').join('\n    ');
  const newHtmlPlanInner = buildPlanLimitsJs(config);
  const newRulesPlanInner = '    ' + buildPlanAllowsCollectionRules(config).split('\n').join('\n    ');

  const htmlContent = fs.readFileSync(HTML_PATH, 'utf8');
  const rulesContent = fs.readFileSync(RULES_PATH, 'utf8');

  let newHtmlContent = replaceBetween(htmlContent, HTML_START, HTML_END, newHtmlInner, 'index.html');
  newHtmlContent = replaceBetween(newHtmlContent, HTML_PLAN_START, HTML_PLAN_END, newHtmlPlanInner, 'index.html');
  let newRulesContent = replaceBetween(rulesContent, RULES_START, RULES_END, newRulesInner, 'firestore.rules');
  newRulesContent = replaceBetween(newRulesContent, RULES_PLAN_START, RULES_PLAN_END, newRulesPlanInner, 'firestore.rules');

  const htmlChanged = newHtmlContent !== htmlContent;
  const rulesChanged = newRulesContent !== rulesContent;

  if (checkOnly) {
    if (htmlChanged || rulesChanged) {
      console.error('❌ Out of sync with role-permissions.json:');
      if (htmlChanged) console.error('   - index.html (ROLE_PERMS or PLAN_LIMITS) needs regenerating');
      if (rulesChanged) console.error('   - firestore.rules (roleCanWrite or planAllowsCollection) needs regenerating');
      console.error('Run `node generate-rules.js` (without --check) to fix, then commit the result.');
      process.exit(1);
    }
    console.log('✅ index.html and firestore.rules both match role-permissions.json.');
    return;
  }

  fs.writeFileSync(HTML_PATH, newHtmlContent);
  fs.writeFileSync(RULES_PATH, newRulesContent);
  console.log(`${htmlChanged ? '✏️  Updated' : '·  Unchanged'} index.html`);
  console.log(`${rulesChanged ? '✏️  Updated' : '·  Unchanged'} firestore.rules`);
}

main();
