/**
 * The texts of the experimental physics rules (src/game/physicsRules.ts): a preset's name (a
 * built-in's comes from the locale), a value as the player reads it (speeds in km/h like the HUD,
 * the rest as % of standard, seconds, on / off or the demolitions option), the standard value of a
 * row, and the one-line summary of what differs from standard ("Gravity 50% · Air drag (ball)
 * 50%"). Text only (t()), no DOM: the Settings > Experimental editor (and its read-only 'match'
 * line in an experimental P2P match), the training screen, the TrainingHud and the custom lobby
 * screens (the rules cycler, the EXP tag's tooltip, the rules line) share it, so a value reads the
 * same everywhere. Called when a screen is built or a value changes, never per frame.
 */
import { t, type Key } from '../i18n';
import { BALL, UU_TO_KMH } from '../sim/constants';
import { physicsField, summarizeChanges, type BuiltInId, type PhysicsContext, type PhysicsField, type PhysicsValues, type RulesSnapshot } from '../game/physicsRules';

/** What a preset needs to be named: the store's ListedPreset. */
export interface NamedPreset {
  readonly id: string;
  readonly builtIn: boolean;
  readonly name: string;
}

/** A preset's name: a built-in's from the locale (rules.builtin.<id>), the player's own as saved. */
export function presetName(p: NamedPreset): string {
  return p.builtIn ? t(`rules.builtin.${p.id as BuiltInId}`) : p.name;
}

/** The demolitions row's options, by stored value (physicsRules: 0 normal, 1 on contact, 2 off). */
const DEMO_KEYS: readonly Key[] = ['rules.demoNormal', 'rules.demoContact', 'rules.demoOff'];

/** A row's label (rules.<key>). */
export function fieldLabel(f: PhysicsField): string {
  return t(`rules.${f.key}`);
}

/** A stored value as the editor shows it: '50%', '216 km/h', '3 s', 'ON', 'On contact', 'Endless'. */
export function formatRuleValue(f: PhysicsField, v: number): string {
  switch (f.display) {
    case 'percent':
      return f.key === 'boostUse' && v === 0 ? t('rules.boostEndless') : `${v}%`;
    case 'speed': {
      // ballMaxSpeed is a % of the ball's top speed; carMaxSpeed is in uu/s already.
      const uu = f.key === 'ballMaxSpeed' ? (BALL.maxSpeed * v) / 100 : v;
      return t('rules.kmh', { value: Math.round(uu * UU_TO_KMH) });
    }
    case 'count':
      return String(v);
    case 'seconds':
      return t('rules.seconds', { value: v });
    case 'toggle':
      return t(v === 1 ? 'settings.on' : 'settings.off');
    case 'option':
      return t(DEMO_KEYS[v] ?? 'rules.demoNormal');
  }
}

/** "Standard 100%": the stock value of a row. */
export function standardText(f: PhysicsField): string {
  return t('rules.standardValue', { value: formatRuleValue(f, f.default) });
}

/**
 * The keys that differ from standard as one line, in table order: "Gravity 50% · Air drag (ball)
 * 50% · +2 more"; "Standard physics" when nothing differs. `context` 'match' leaves out the
 * free-play-only keys (game speed).
 */
export function rulesSummary(values: Readonly<PhysicsValues>, max = 4, context: PhysicsContext = 'training'): string {
  const all = summarizeChanges(values, Infinity, context);
  if (all.length === 0) return t('rules.standardPhysics');
  const parts: string[] = [];
  for (const { key, value } of all.slice(0, Math.max(1, max))) {
    const f = physicsField(key) as PhysicsField;
    parts.push(`${fieldLabel(f)} ${formatRuleValue(f, value)}`);
  }
  if (all.length > parts.length) parts.push(t('rules.more', { count: all.length - parts.length }));
  return parts.join(' · ');
}

/**
 * A lobby's (or a room's) experimental rules on one line: their name, then what they change in a
 * match, every key ("Moon ball · Gravity 40% · Ball bounce 130%"); the name alone when they change
 * nothing. The custom lobby screens and the editor's read-only 'match' line.
 */
export function lobbyRulesLine(rules: Readonly<RulesSnapshot>): string {
  return summarizeChanges(rules.values, 1, 'match').length > 0 ? `${rules.name} · ${rulesSummary(rules.values, Infinity, 'match')}` : rules.name;
}
