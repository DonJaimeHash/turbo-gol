/**
 * Experimental physics rules as the menus write them (src/game/physicsRules.ts, Settings >
 * Experimental): one value with its label ("Gravity 50%", "Car top speed 94 km/h", "Demolitions
 * Off"), the changes of a set of values on one line, and a custom lobby's rules line
 * ("Low gravity · Gravity 50% · Air drag (ball) 50%"). Speeds in km/h like the HUD (uu/s x
 * UU_TO_KMH), everything else in % of standard, as a count, in seconds or as the option's name.
 */
import { t, type Key } from '../i18n';
import { physicsField, summarizeChanges, type PhysicsKey, type PhysicsValues, type RulesSnapshot } from '../game/physicsRules';
import { UU_TO_KMH } from '../sim/constants';
import { STOCK_MUTATORS, M_BALL_MAX_SPEED } from '../sim/mutatorLayout';

const DEMO_OPTIONS: readonly Key[] = ['rules.demoNormal', 'rules.demoContact', 'rules.demoOff'];

/** A value of `key` as the menus show it, without the label ("50%", "281 km/h", "On", "2 s"). */
export function formatRuleValue(key: PhysicsKey, value: number): string {
  const f = physicsField(key);
  if (f === undefined) return String(value);
  switch (f.display) {
    case 'speed': {
      // ballMaxSpeed is a % of the stock top speed, carMaxSpeed a figure in uu/s.
      const uu = key === 'ballMaxSpeed' ? (STOCK_MUTATORS[M_BALL_MAX_SPEED] * value) / 100 : value;
      return `${Math.round(uu * UU_TO_KMH)} km/h`;
    }
    case 'toggle':
      return t(value === 1 ? 'settings.on' : 'settings.off');
    case 'option':
      return t(DEMO_OPTIONS[value] ?? 'rules.demoNormal');
    case 'seconds':
      return `${value} s`;
    case 'count':
      return String(value);
    default:
      return `${value}%`;
  }
}

/** "Gravity 50%": the label of `key` and its value; a toggle that is on is its label alone ("Unlimited flips"). */
export function formatRule(key: PhysicsKey, value: number): string {
  const label = t(`rules.${key}` as Key);
  return physicsField(key)?.display === 'toggle' && value === 1 ? label : `${label} ${formatRuleValue(key, value)}`;
}

/** The changes of `values` from standard in a match (table order, at most `n`), joined by " · ". */
export function rulesChanges(values: Readonly<PhysicsValues>, n = Infinity): string {
  return summarizeChanges(values, n, 'match')
    .map((c) => formatRule(c.key, c.value))
    .join(' · ');
}

/** A lobby's rules on one line: their name, then what they change ("Low gravity · Gravity 50% · …"). */
export function rulesSummary(rules: Readonly<RulesSnapshot>, n = Infinity): string {
  const changes = rulesChanges(rules.values, n);
  return changes.length > 0 ? `${rules.name} · ${changes}` : rules.name;
}
