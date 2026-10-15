/** The menus with every screen registered (the Game creates one). */
import { Menu } from './Menu';
import type { MenuHost } from './Menu';
import { casualScreen, friendlyScreen, homeScreen, playScreen, rankedScreen } from './screens/play';
import { customScreen, lobbyCreateScreen, lobbyScreen } from './screens/custom';
import { trainingScreen } from './screens/training';
import { profileScreen } from './screens/profile';
import { leaderboardScreen } from './screens/leaderboard';

export { Menu } from './Menu';
export type { MenuHost, MenuConfig, SearchRequest, SearchView } from './Menu';
export { showRankedResult } from './screens/leaderboard';

export function createMenu(host: MenuHost, container: HTMLElement): Menu {
  const m = new Menu(host, container);
  m.register('home', homeScreen);
  m.register('play', playScreen);
  m.register('casual', casualScreen);
  m.register('ranked', rankedScreen);
  m.register('friendly', friendlyScreen);
  m.register('custom', customScreen);
  m.register('lobby-create', lobbyCreateScreen);
  m.register('lobby', lobbyScreen);
  m.register('training', trainingScreen);
  m.register('profile', profileScreen);
  m.register('leaderboard', leaderboardScreen);
  return m;
}
