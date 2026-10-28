/** The menus with every screen registered (the Game creates one). */
import { Menu } from './Menu';
import type { MenuHost } from './Menu';
import { homeScreen } from './screens/home';
import { modesScreen } from './screens/modes';
import { lobbyScreen } from './screens/lobby';
import { trainingScreen } from './screens/training';
import { profileScreen } from './screens/profile';
import { leaderboardScreen } from './screens/leaderboard';
import { garageScreen } from './screens/garage';

export { Menu } from './Menu';
export type { MenuHost, MenuConfig, SearchRequest, SearchView } from './Menu';
export { RankedResults } from './screens/leaderboard';

export function createMenu(host: MenuHost, container: HTMLElement): Menu {
  const m = new Menu(host, container);
  m.register('home', homeScreen);
  m.register('modes', modesScreen);
  m.register('lobby', lobbyScreen);
  m.register('training', trainingScreen);
  m.register('profile', profileScreen);
  m.register('leaderboard', leaderboardScreen);
  m.register('garage', garageScreen);
  return m;
}
