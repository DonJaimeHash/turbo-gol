/**
 * English: the source of truth for every text in the game (src/i18n.ts). To translate, copy this
 * file to src/locales/<code>.ts and follow CONTRIBUTING.md ("Translating"). Keep each key and its
 * {placeholders}; plural texts list the forms of Intl.PluralRules ('one', 'other'...).
 */
import type { Messages } from '../i18n';

export default {
  // Language picker
  'lang.title': 'Language',
  // PERFIL's section heading over the language row (in capitals, as the other headings)
  'lang.auto': 'Automatic ({language})',
  'lang.busy': 'Stop searching or leave the lobby to change the language',
  // Over the list: choosing another language reloads the page
  'lang.reloadNote': 'The game reloads (a few seconds)',
  // Closes the language picker without a change
  'lang.cancel': 'CANCEL',

  // Names of shared ids (src/ui/names.ts; a playlist is named by its format alone: 1v1, 2v2, 3v3)
  'region.SA': 'South America',
  'region.NA': 'North America',
  'region.EU': 'Europe',
  'region.AS': 'Asia',
  'region.OC': 'Oceania',
  'region.AF': 'Africa',
  // A guest's name: the server names every guest 'Invitado 4821' (src/net/guestName.ts) and each
  // page shows it in its language (src/ui/names.ts playerName); {n} is its four digits
  'guest.name': 'Guest {n}',
  'difficulty.easy': 'Easy',
  'difficulty.medium': 'Normal',
  'difficulty.hard': 'Hard',
  // Graphics quality tiers (src/render/quality.ts): Settings > Graphics
  'quality.superlow': 'Super low',
  'quality.low': 'Performance',
  'quality.high': 'High',
  'quality.ultra': 'Ultra',
  // A tier broke on this device and the game fell back one tier (src/render/tierGuard.ts): a toast /
  // the loading line; {from} and {to} are quality.superlow / quality.low / quality.high / quality.ultra
  'quality.fallback': 'Your device does not support {from}: using {to}',
  // Toast when an online match starts on Super low (it still connects)
  'quality.superlowOnline': 'Super low: online matches may not run smoothly on this device',
  // The graphics device was lost (src/render/tierGuard.ts lossStep): the loading line before the
  // page reloads, the second time it reloads on Super low, the third time it stops
  'gpu.lostReload': 'The graphics device stopped: restarting…',
  'gpu.lostRecover': 'The graphics device stopped again: restarting on Super low…',
  'gpu.lostStop': 'The graphics device keeps stopping. Close other apps and reload the page.',
  // Stadium themes (src/render/theme.ts): the Friendly screen's stadium row
  'theme.harbour-night': 'Night harbour',
  'theme.canyon-sunset': 'Red canyon',
  'theme.alpine-day': 'Alpine valley',
  // Cosmetic cars (src/game/cosmetics.ts): the garage and the shop. The names are invented proper
  // names, Spanish words kept as they are (the pampas wind, the capybara, the condor, the southern
  // lapwing); each *Desc is the car's one line under its name
  'car.dune': 'Dune',
  'car.duneDesc': 'Bubble canopy, roll hoop and knobby tyres: the all-rounder',
  'car.pampero': 'Pampero',
  'car.pamperoDesc': 'Low and sharp, like the cold wind of the pampas',
  'car.carpincho': 'Carpincho',
  'car.carpinchoDesc': 'Round, sturdy and unflappable, like the capybara',
  'car.condor': 'Cóndor',
  'car.condorDesc': 'Long and wide, built to glide',
  'car.tero': 'Tero',
  'car.teroDesc': 'A compact rally hatch, loud and always on the alert',
  'tier.bronze': 'Bronze',
  'tier.silver': 'Silver',
  'tier.gold': 'Gold',
  'tier.platinum': 'Platinum',
  'tier.diamond': 'Diamond',
  'tier.elite': 'Elite',
  'tier.master': 'Master',
  'tier.legend': 'Legend',
  // A tier and its division numeral: 'Gold II'
  'tier.division': '{tier} {division}',

  // Menu chrome: top bar, footer, key hints, search banner (src/ui/Menu.ts)
  // The link to the game's source code (hint bar, the phone's rail, About); {license} is the license
  // id (AGPL-3.0). The AGPL-3.0 requires this link in every language: never drop it.
  'menu.sourceTitle': 'Source code ({license})',
  // Its short form, where the hint bar is crowded (a TV's pills with a wide system font)
  'menu.sourceShort': 'Source ({license})',
  // Footer link to the third-party licenses file
  'menu.licenses': 'Licenses',
  // Tooltip of the footer Discord link. The community server speaks English, so other languages may say so, as the Spanish does
  'menu.discordTitle': 'Community on Discord',
  // Top-bar account chip, under the player name, when signed in with no rank yet
  'menu.account': 'Account',
  // Top-bar account chip, under the guest name (it opens PROFILE, where a guest signs in)
  'menu.guestSignIn': 'Sign in',
  // Top bar: players in a match in the selected region
  'menu.playing': { one: '{count} playing', other: '{count} playing' },
  // Top-bar region when set to automatic, before the server has said which region
  'menu.regionAuto': 'Auto',
  // Top-bar region when set to automatic; {region} is the detected region's name
  'menu.regionAutoNamed': 'Auto · {region}',
  // Search pill (top bar): the kind of search, before its formats and time ('CASUAL · 2v2 · 0:42')
  'menu.searchRanked': 'COMPETITIVE',
  // Search pill: the kind of search
  'menu.searchCasual': 'CASUAL',
  // Tooltip / screen-reader name of the '‹' button of a stacked screen: back to the previous screen
  'menu.back': 'Back',
  // Dialog on the home screen after the system Back (Android's back gesture or button, a TV remote's
  // BACK, the browser's back button); {game} is the game's name
  'menu.leaveTitle': 'Leave {game}?',
  // The dialog's text: while it is up, the next Back leaves the page ("Back" is the system button)
  'menu.leaveText': 'Press Back again to leave.',
  // The same dialog opened by Esc, a controller's B or the menus' ‹ (another press of those closes
  // it): the LEAVE button is the way out
  'menu.leaveTextKey': 'Choose LEAVE to close the game.',
  // ... and when there is no page before the game's to go back to (no LEAVE button)
  'menu.leaveTextTab': 'To leave, close this tab.',
  // The dialog's buttons, uppercase: close it / go back to the page before the game
  'menu.leaveStay': 'KEEP PLAYING',
  'menu.leaveGo': 'LEAVE',

  // The menu shell (src/ui/shell/*): sections, hints, pills, About, the new-version sheet
  // The five sections, in the top bar (PC, TV) and the phone's rail: capitals, short (the rail
  // gives each 91 px at 14 px on a phone held sideways; a longer one shrinks to fit)
  'nav.play': 'PLAY',
  'nav.training': 'TRAINING',
  'nav.garage': 'GARAGE',
  'nav.leaderboard': 'LEADERBOARD',
  'nav.profile': 'PROFILE',
  // The same in an upright phone's tab bar, where five share 390 px: at most about 8 letters
  'nav.trainingShort': 'TRAIN',
  'nav.leaderboardShort': 'RANKS',
  // The modes screen's breadcrumb (PLAY › MODES › CASUAL: plan PR 6)
  'nav.modes': 'MODES',
  // Screen-reader name of the section bar; also the hint bar's verb for switching sections
  'nav.sections': 'Sections',
  // Hint bar verb for Q / E on a screen with tabs of its own (Leaderboard's playlists)
  'nav.tabs': 'Tabs',
  // The same on MODES, whose tabs are the modes (Q E / LB RB step them)
  'nav.tabsModes': 'Modes',
  // Hint bar verbs, after a drawn key or button (A, ENTER, OK...)
  'nav.select': 'Select',
  'nav.back': 'Back',
  // The hint bar's Back on a TV remote (its ↩ button)
  'nav.backRemote': 'Back',
  'nav.settings': 'Settings',
  'nav.cancelSearch': 'Cancel search',
  // Tooltips of the ‹ › beside the sections (mouse)
  'nav.prevSection': 'Previous section',
  'nav.nextSection': 'Next section',
  // Hint bar link and rail button: the About sheet (build, licenses, Discord)
  'nav.about': 'About',
  // About sheet title; {game} is the game's name
  'nav.aboutTitle': 'About {game}',
  // Closes the About sheet
  'nav.close': 'CLOSE',
  // Region pill: the connection is up (below 5 players in a match no count is shown)
  'pill.online': 'Online',
  // Region pill: the server cannot be reached; RETRY tries again
  'pill.offline': 'Offline',
  'pill.retry': 'RETRY',
  'pill.connecting': 'Connecting…',
  // Region pill's screen-reader name; {state} is pill.online or menu.playing
  'pill.regionLabel': 'Region: {region}, {state}. Change region',
  // The server refused this page's version (a new one was deployed): a sheet that stays until
  // answered, then the top bar's pill
  'update.title': "There's a new version",
  'update.text': 'Reload the page to keep playing online. It takes a few seconds.',
  'update.reload': 'RELOAD NOW',
  'update.later': 'NOT NOW',
  'update.pill': 'UPDATE TO PLAY',

  // Rank badges and rating cards (src/ui/badges.ts)
  // Rank badge tooltip and rating card while placement matches are still left
  'badge.unranked': 'Unranked',
  // Rating card: the matchmaking rating number
  'badge.mmr': '{mmr} MMR',
  // Rating card during placement: matches played out of the placement total
  'badge.placement': 'Placement matches: {played} / {total}',
  // Rating card: wins and losses, abbreviated (W = wins, L = losses)
  'badge.record': '{wins} W · {losses} L',
  // Rating card: no match played in this playlist yet
  'badge.noGames': 'No matches played',

  // Shared screen rows (src/ui/screens/common.ts)
  // Label of the region selector row
  'common.region': 'Region',
  // Region selector option: automatic, before the server has said which region
  'common.regionAuto': 'Automatic',
  // Region selector option: automatic; {region} is the detected region's name
  'common.regionAutoNamed': 'Automatic ({region})',

  // Inicio, PLAY's root (src/ui/screens/home.ts)
  // Its title (breadcrumb)
  'home.title': 'Home',
  // The hero: plays the last queue in one press
  'home.playNow': 'PLAY NOW',
  // The same on a TV (less room at 3 m)
  'home.playNowTv': 'PLAY',
  // The hero's corner tag: a match always starts (bots fill the empty places)
  'home.alwaysMatch': 'ALWAYS A MATCH',
  // The hero while a search runs, over its clock
  'home.searching': 'SEARCHING',
  // The hero while the player is in a lobby
  'home.backToLobby': 'BACK TO THE LOBBY',
  // Under it: {code} is the lobby's code, {count} / {max} its players and places
  'home.lobbySub': 'Lobby {code} · {count}/{max}',
  // The hero while a match of this tab still runs after a reload
  'home.rejoin': 'BACK TO YOUR MATCH',
  // Under it: {queue} is 'Casual · 2v2', {time} the match time left (m:ss)
  'home.rejoinSub': '{queue} · {time} left',
  // The player plate: a guest's line under its name ('Guest 4821'), an account's without a placed rank
  'home.guestRank': 'No account · Unranked',
  'home.unranked': 'Unranked',
  // The plate's line on a TV, after the rank; {car} is the car's name
  'home.carLine': 'Car: {car}',
  // Screen-reader names of the plate's two buttons; {rank} is a rank ('Gold II · 2v2') or home.unranked
  'home.plateProfile': 'Profile: {name}, {rank}',
  'home.plateGarage': 'Garage: your car is {car}',

  // GARAJE (src/ui/screens/garage.ts, plan §1.4.2): the cars and the stadiums. Server points are
  // earned only by hosting a community server (nodes/docs/RECOMPENSAS.md): never bought, won by
  // playing or traded, and nothing is paid. Never state a rate (points per minute or per match): it
  // depends on verification and the region. {points}, {have}, {missing}, {from}, {to} are formatted numbers
  'garage.tabCars': 'CARS',
  'garage.tabStadiums': 'STADIUMS',
  // The hint bar's verb for the two tabs (LT RT / Q E)
  'garage.tabsVerb': 'Cars or stadiums',
  // The card of the car driven, its corner, the free car's line
  'garage.yourCar': 'YOUR CAR',
  'garage.equippedTag': 'EQUIPPED',
  'garage.free': 'Free for everyone',
  'garage.freeTag': 'FREE',
  // The unit after a number of points
  'garage.pts': 'PTS',
  'garage.signIn': 'SIGN IN',
  'garage.guest': 'You play as a guest',
  'garage.paused': 'Redeeming paused · check My server in your profile',
  // The lime card: every car's price, then how points are earned; its short form on a phone
  'garage.eachCar': 'EACH CAR · {points} PTS',
  'garage.earn': 'EARN POINTS BY HOSTING A COMMUNITY SERVER',
  'garage.earnSub': 'On your PC or a VPS · see the guide',
  'garage.earnShort': 'How to earn points',
  // A row's state
  'garage.stateEquipped': 'Equipped',
  'garage.stateEquippedFree': 'Equipped · Free',
  'garage.stateOwned': 'Yours',
  'garage.stateClaimable': 'Redeemable · {points} pts',
  'garage.stateLocked': 'Locked · {points} pts',
  // A car whose body is still being built: it cannot be redeemed yet
  'garage.stateSoon': 'Coming soon',
  // The detail card's action and the line under it
  'garage.equip': 'EQUIP',
  'garage.redeem': 'REDEEM FOR {points} PTS',
  'garage.inUse': 'You drive it in your next match',
  'garage.needSignIn': 'Sign in to redeem',
  'garage.missing': 'You have {have} pts: {missing} to go',
  'garage.needFrozen': 'Redeeming paused',
  'garage.needMatches': 'Your server needs a verified match first',
  'garage.needUnavailable': 'It cannot be redeemed right now',
  'garage.needLoading': 'Loading…',
  'garage.soonText': 'Its body is still being built',
  // The redeem sheet; {car} is the car's name
  'garage.redeemTitle': 'Redeem {car}',
  'garage.cost': 'Cost: {points} server points',
  'garage.balance': 'Balance: {from} → {to}',
  'garage.noPay': 'Nothing is paid: cars come only with server points, never by playing',
  'garage.cancel': 'CANCEL',
  'garage.hold': 'HOLD TO CONFIRM',
  // After it
  'garage.redeemed': '{car} is yours',
  'garage.same': 'Same handling, same hitbox: only the look changes',
  'garage.equipNow': 'EQUIP NOW',
  'garage.done': 'DONE',
  'garage.failTitle': "We couldn't redeem it",
  'garage.failText': 'Nothing was spent.',
  'garage.retry': 'RETRY',
  // Toast; {car} is the car's name
  'garage.equipped': '{car} equipped',
  'garage.loading': 'Loading your points…',
  // How points are earned (GANA PUNTOS, a locked car's REDEEM): the guide and its QR
  'garage.guideTitle': 'How to earn server points',
  'garage.guideText': 'Host a community server on your PC or a VPS: every verified match it hosts adds points. Playing never earns them.',
  'garage.guideScan': 'Scan it to open the guide on your phone.',
  'garage.guideOpen': 'OPEN THE GUIDE',
  // ESTADIOS
  'garage.stadiumInUse': 'In use',
  'garage.stadiumUse': 'USE THIS STADIUM',
  'garage.stadiumNote': 'Used in your offline matches, in training and behind the menus',
  // Server points everywhere (PUNTOS DE SERVIDOR card, the bar's pill)
  'points.title': 'SERVER POINTS',
  'points.only': 'Earned only by hosting a community server. Never sold.',
  // The bar's pill on GARAJE and PERFIL, after the number
  'points.words': 'server points',

  // Inicio's mode tiles: a title, a subtitle (PC) and its short form (phone, tablet, TV), a corner tag
  'modes.casual': 'CASUAL',
  'modes.casualSub': 'Quick matches, no rank',
  'modes.casualSubShort': 'Quick, no rank',
  'modes.friends': 'WITH FRIENDS',
  'modes.friendsSub': 'Make a lobby, share the link',
  'modes.friendsSubShort': 'Private lobby, link',
  // The short form on a TV (no link to share there: a code)
  'modes.friendsSubTv': 'Make a lobby with a code',
  // The tag of WITH FRIENDS
  'modes.lobbies': 'LOBBIES',
  // Against the bots, offline (also the offline hero's title)
  'modes.vsAi': 'VS AI',
  'modes.vsAiSub': '3-min match · offline',
  'modes.vsAiSubShort': '3 min · offline',
  'modes.vsAiSlot': 'FRIENDLY',
  'modes.ranked': 'COMPETITIVE',
  'modes.rankedSub': 'Climb the ranks · 5 placement matches',
  'modes.rankedSubShort': 'Climb the ranks',
  // COMPETITIVE's lock tag for a guest where menu.guestSignIn does not fit (a phone, a tablet)
  'modes.signInShort': 'Sign in',

  // MODES (src/ui/screens/modes.ts): its tabs (the titles above), the second line of two of them, and
  // a guest's on COMPETITIVE
  'modes.tabLobbiesSub': 'With friends, by code',
  'modes.tabAiSub': 'Friendly · offline',
  'modes.rankedLocked': 'Needs an account',
  'modes.rankedIntro': 'One rank per format. Leaving a match locks Competitive.',
  'modes.format': 'FORMAT',
  // Region's row is common.region; this row opens the connection sheet
  'modes.advanced': 'Advanced',
  'modes.connection': 'Connection',
  // The Advanced row's value; {net} is modes.netAuto / netP2p / netServer
  'modes.connectionValue': 'Connection: {net}',
  'modes.netAuto': 'Auto',
  'modes.netP2p': 'P2P',
  'modes.netServer': 'Server',
  // Each choice's line in the connection sheet
  'modes.netAutoHelp': 'The matchmaker picks: P2P with other players, a server if you play alone',
  'modes.netP2pHelp': 'Cars sync directly between players; alone, a server with bots',
  'modes.netServerHelp': 'A server in your region; bots join sooner',
  // LOBBIES' action zone, over CREATE LOBBY
  'modes.lobbiesAction': 'Make a lobby and share its code',
  // The formats: a playlist is its format (1v1, 2v2, 3v3); ANY is whichever fills first
  'format.any': 'ANY',
  'format.anySub': '1v1, 2v2 or 3v3',
  'format.fastest': 'FASTEST',
  // The action zone and the searching panel (plan §1.4.1)
  'search.find': 'FIND MATCH',
  'search.title': 'FINDING A MATCH',
  'search.unranked': 'UNRANKED',
  'search.rankedTag': 'RANKED',
  // {format} is '2v2' or format.anySub, {region} a region's name
  'search.where': 'Looking for {format} in {region}',
  // Followed by the time left (m:ss)
  'search.bots': 'Bots join in',
  'search.always': "There's always a match: if nobody comes, you play bots.",
  'search.cancel': 'CANCEL SEARCH',
  // Followed by training.freePlay, underlined: free play with the search still on
  'search.whileWaiting': 'While you wait:',
  'search.formatRestarts': 'Changing the format restarts the search.',
  'search.needsAccount': 'Competitive needs an account',
  'search.signIn': 'SIGN IN',
  // {time} is duration() of the ban left: '24 hr'
  'search.banned': 'Competitive locked · {time}',
  'search.bannedLine': 'For leaving matches',
  'search.playCasual': 'PLAY CASUAL',
  // Free play while searching found a match: the banner until the match is on screen
  // Free play's line on the training HUD while the search goes on
  'search.practiceLine': 'Finding a match…',

  // A TV without a controller: the hero's tag, then a sheet at a match's start (it closes by itself
  // when a controller connects)
  'tv.needPad': 'YOU NEED A CONTROLLER',
  'tv.needPadText': 'Connect a controller (USB or Bluetooth) to play',
  // Starts the match anyway (the remote's arrows drive)
  'tv.needPadGo': 'CONTINUE ANYWAY',

  // Asked once, at a new PC player's first match (src/ui/howPlay.ts): sets the controls
  'howPlay.title': 'How will you play?',
  'howPlay.kbm': 'MOUSE AND KEYBOARD',
  'howPlay.keyboard': 'KEYBOARD ONLY',
  'howPlay.pad': 'CONTROLLER',

  // Casual and Competitive by name in a sentence (Inicio's hero subtitle: home.ts)
  'play.casualTitle': 'Casual',
  // Placement matches played / needed
  'play.placement': 'Placement {games}/{total}',
  // {time} is a live m:ss countdown
  'play.rankedBan': 'Competitive locked for leaving matches: {time}',
  'play.rankedTitle': 'Competitive',

  // MODES' VS AI tab (src/ui/screens/modes.ts)
  'friendly.mode': 'Mode',
  'friendly.difficulty': 'AI difficulty',
  // Where the match is played (the stadium's setting: harbour, canyon...); purely visual
  'friendly.theme': 'Stadium',
  // Under the stadium sheet's title (components/stadium.ts): the pick is not for this match only
  'friendly.themeNote': 'Used in all your matches and behind the menus',
  'friendly.intro': 'A 3-minute offline match against the AI. Your teammates, if any, are bots too.',
  // Starts the friendly match
  'friendly.play': 'PLAY',

  // Custom lobbies (src/ui/screens/custom.ts)
  // Match length option: no time limit
  'custom.noLimit': 'No limit',
  // Match length in minutes (3, 5 or 10)
  'custom.minutes': { one: '{count} min', other: '{count} min' },
  // Connection type: peer to peer
  'custom.netP2p': 'P2P',
  // Connection type: a server hosts the match
  'custom.netServer': 'Server',
  'custom.wrongPassword': 'Wrong password',
  'custom.joinPassword': 'Lobby password',
  // Title of the password dialog; {code} is the 6-character join code
  'custom.joinTitle': 'Lobby {code}',
  'custom.joinLocked': 'This lobby has a password.',
  'custom.join': 'JOIN',
  'custom.cancel': 'CANCEL',
  // Label of the join-by-code field
  'custom.codeField': 'Code',
  'custom.codeInvalid': 'The code is 6 letters or numbers',
  // Lobby list, status column
  'custom.rowInGame': 'In match',
  // Lobby list, status column
  'custom.rowFull': 'Full',
  // Lobby list, status column
  'custom.rowOpen': 'Open',
  'custom.noLobbies': 'No public lobbies in {region}. Create one!',
  // Under the lobby list: how many public lobbies, and the region
  'custom.lobbyCount': { one: '{count} lobby · {region}', other: '{count} lobbies · {region}' },
  'custom.subtitle': 'Public lobbies in your region, or private ones by code. They never change your rank.',
  // Button on the lobby browser and heading of the create screen
  'custom.createLobby': 'CREATE LOBBY',
  'custom.refresh': 'REFRESH',
  // Lobby list column headers (colName ... colState)
  'custom.colName': 'Name',
  'custom.colMode': 'Mode',
  'custom.colPlayers': 'Players',
  'custom.colHost': 'Host',
  'custom.colNet': 'Network',
  'custom.colState': 'Status',
  'custom.loading': 'Loading lobbies…',
  // Lobby settings labels (settingMode ... settingLength)
  'custom.settingMode': 'Mode',
  'custom.settingVisibility': 'Visibility',
  'custom.visibilityPublicListed': 'Public (listed)',
  'custom.visibilityPrivateCode': 'Private (code only)',
  'custom.settingNet': 'Connection',
  'custom.netP2pRecommended': 'P2P (recommended)',
  'custom.settingLength': 'Duration',
  'custom.nameField': 'Lobby name',
  'custom.passwordOptional': 'Password (optional)',
  // Placeholder of the optional password field
  'custom.noPassword': 'No password',
  'custom.create': 'CREATE',
  // Lobby name validation error
  'custom.nameLength': '3 to 24 characters',
  'custom.createSubtitle': "You're the host: you pick the teams, the mode and when it starts. Bots fill the empty slots.",
  'custom.lobbySection': 'LOBBY',
  // Breadcrumb title of the create screen
  'custom.createTitle': 'Create lobby',
  // Default lobby title, shown for the server's default (the host's name; src/ui/names.ts lobbyTitle); {name} is the host (up to 16 characters, a guest's 'Guest 4821'). Keep it to letters, digits, spaces and _ . - ! ? #, at most 8 characters besides {name}: no apostrophes, quotes, colons, commas or brackets (tests/i18n-lobby-name.test.mjs).
  'custom.defaultName': 'Lobby {name}',
  // The host's SETTINGS as a guest: the lobby's title cannot be changed, and why
  'custom.guestTitle': 'With an account you can name your lobby.',
  'custom.tagGuest': 'GUEST',
  'custom.tagInMatch': 'IN MATCH',
  // Host button: remove a player from the lobby
  'custom.kick': 'Kick',
  'custom.newPassword': 'New password (empty = no password)',
  'custom.configureTitle': 'Lobby settings',
  'custom.save': 'SAVE',
  'custom.joining': 'Joining the lobby…',
  'custom.notInLobby': "You're not in a lobby",
  'custom.back': 'BACK',
  // Lobby summary line, e.g. '2v2 · P2P · 5 min · Public'. {lock} is ' · 🔒' when the lobby has a password, else empty.
  'custom.info': '{mode} · {net} · {length} · {visibility}{lock}',
  'custom.public': 'Public',
  'custom.private': 'Private',
  // Label next to the lobby's join code
  'custom.codeLabel': 'CODE',
  'custom.copy': 'COPY',
  'custom.copied': 'Code copied',
  'custom.copyFailed': "Couldn't copy",
  'custom.botSlot': 'Bot (open slot)',
  'custom.teamBlue': 'BLUE',
  'custom.teamRed': 'RED',
  'custom.statusInGame': 'Match in progress: the lobby reopens when everyone is back',
  'custom.statusStarting': 'Starting match…',
  'custom.statusHost': "You're the host. Start the match when everyone is here.",
  'custom.statusWaiting': 'Waiting for the host to start the match…',
  'custom.start': 'START MATCH',
  'custom.otherTeamFull': 'THE OTHER TEAM IS FULL',
  'custom.switchTeam': 'SWITCH TEAMS',
  // Host button: opens the lobby settings
  'custom.configure': 'SETTINGS',
  'custom.leaveLobby': 'LEAVE LOBBY',
  // Breadcrumb title of the lobby screen
  'custom.lobbyTitle': 'Lobby',
  'custom.leaveTitle': 'Leave the lobby?',
  'custom.leaveHost': "You're the host: the player here longest takes over.",
  'custom.leaveMember': 'You can rejoin with the code while the lobby exists.',
  'custom.leave': 'LEAVE',
  'custom.stay': 'STAY',
  // Experimental rules in a custom lobby (Settings > Experimental presets; signed-in players only)
  // Host setting: the rules cycler (Standard, the built-ins, the player's presets); P2P only
  'custom.settingRules': 'Rules (experimental)',
  // Host button next to the rules cycler: opens Settings > Experimental, then comes back here
  'custom.editPresets': 'EDIT PRESETS',
  // Under the rules cycler when experimental rules are picked
  'custom.rulesNote': 'Signed-in players only. The match counts for nothing: no rank, no stats',
  // Lobby screen line before the match; {summary} is e.g. 'Low gravity · Gravity 50% · Air drag (ball) 50%'
  'custom.rulesInfo': 'Experimental rules: {summary}',
  // Short tag of a lobby with experimental rules (lobby list, lobby title)
  'custom.tagExperimental': 'EXP',

  // Salas and the lobby (plan PR 12: src/ui/screens/lobby.ts, custom.ts, components/codecells.ts)
  // MODOS › SALAS' primary: a private lobby with the last format, then its screen
  'lobby.createShare': 'CREATE LOBBY AND SHARE',
  // The empty list's own button (the same private lobby)
  'lobby.createPrivate': 'CREATE PRIVATE LOBBY',
  // The primary while the player is in a lobby; {code} as 'ABC 234'
  'lobby.backTo': 'BACK TO LOBBY {code}',
  'lobby.joinCode': 'JOIN WITH CODE',
  'lobby.joinCodeSub': '6 letters or numbers',
  'lobby.public': 'PUBLIC LOBBIES',
  // Empty list; {region} is the region's name
  'lobby.empty': 'No public lobbies in {region}',
  // A list row's state slot
  'lobby.rowOpen': 'OPEN',
  'lobby.rowInMatch': 'IN MATCH',
  'lobby.rowFull': 'FULL',
  // Pressing a full / playing row says why
  'lobby.whyFull': 'That lobby is full',
  'lobby.whyInMatch': "That lobby is playing a match: try when it's over",
  // The code entry (mn-codecells) sheet
  'lobby.codeTitle': 'Join with code',
  'lobby.codeLabel': 'Lobby code',
  'lobby.join': 'JOIN',
  // The lobby screen
  'lobby.share': 'SHARE',
  // navigator.share's text; {code} as 'ABC 234', {game} the game's name
  'lobby.shareText': 'Join my {game} lobby {code}',
  'lobby.linkCopied': 'Link copied',
  'lobby.codeCopied': 'Code copied',
  // The TV's share sheet: the QR, the code, the short link
  'lobby.qrTitle': 'Scan to join',
  'lobby.start': 'START',
  // A member's toggle (informative: the host can start anyway)
  'lobby.ready': 'READY',
  // The "…" menu
  'lobby.more': 'More',
  'lobby.settings': 'SETTINGS',
  'lobby.leave': 'LEAVE LOBBY',
  'lobby.reconnecting': 'Reconnecting to the lobby…',
  // Tags on a member's row
  'lobby.tagHost': 'HOST',
  'lobby.tagYou': 'YOU',
  'lobby.tagReady': 'READY',
  'lobby.tagAway': 'RECONNECTING',
  'lobby.tagInMatch': 'IN MATCH',
  'lobby.openSlot': 'Open · bot',
  // The member sheet; {team} is BLUE / RED
  'lobby.moveTo': 'MOVE TO {team}',
  'lobby.makeHost': 'MAKE HOST',
  'lobby.kick': 'KICK',
  'lobby.kickTitle': 'Kick {name}?',
  'lobby.kickBody': "They can't come back to this lobby.",
  // Leaving the lobby screen for another place; {code} as 'ABC 234'
  'lobby.leaveTitle': 'Leave lobby {code}?',
  'lobby.leaveHost': 'The player here longest becomes the host.',
  // Go on, still in the lobby (the pill brings it back)
  'lobby.keep': 'KEEP THE LOBBY',
  'lobby.cancel': 'CANCEL',
  // The pill while in a lobby elsewhere ('· 2/4' follows); {code} as 'ABC234'
  'lobby.pill': 'LOBBY {code}',
  'lobby.pillBack': 'BACK',
  // A join link's sheet; {mode} is 1v1 / 2v2 / 3v3
  'lobby.joinAsk': 'Join lobby {code} · {mode} · {count}/{max}?',
  'lobby.joinAskCode': 'Join lobby {code}?',
  // In another lobby already: joining this one leaves it
  'lobby.swap': 'You leave lobby {code}.',
  // A restart (Super low) took longer than the server keeps a place in the lobby
  'lobby.stayLate': 'Lobby {code} went on without you: join it again with its code',
  'lobby.stayBack': 'Back in lobby {code}: you took a while, the host may have changed',

  // A lost server match (plan PR 12: src/ui/screens/match/lost.ts)
  'lost.title': 'Your connection dropped',
  'lost.body': 'The match goes on without you',
  'lost.ranked': 'You can come back from Competitive',
  'lost.rejoin': 'REJOIN',
  'lost.menu': 'MENU',

  // What a failed online step offers (src/net/outcome.ts)
  'outcome.retry': 'RETRY',
  'outcome.wait': 'TRY AGAIN IN 1 MIN',
  'outcome.requeue': 'BACK IN THE QUEUE',
  'outcome.reload': 'RELOAD',
  'outcome.close': 'CLOSE',

  // Profile and account forms (src/ui/screens/profile.ts)
  // Screen title (window / back stack)
  'profile.title': 'Profile',
  'profile.heading': 'PROFILE',
  // A server error and the wait before retrying, in whole seconds (rounded up)
  'profile.retryAfter': '{message} ({seconds} s)',
  // A username's password sign-in paused after many failures from new browsers (server/src/AccountsDO.ts LOGIN_USER_DAY_MAX): 30 to 60 minutes, rounded up
  'profile.retryNewDevice': 'Too many attempts on this account from new devices. Sign in from a device you have used before, or wait {minutes} min.',
  'profile.codesTitle': 'Recovery codes',
  'profile.codesNote': "Each code works once to reset your password if you forget it. There's no email recovery: keep them somewhere safe.",
  'profile.copy': 'COPY',
  'profile.codesCopied': 'Codes copied',
  'profile.copyFailed': "Couldn't copy",
  'profile.codesSaved': "I'VE SAVED THEM",
  'profile.tabSignIn': 'SIGN IN',
  'profile.tabRegister': 'CREATE ACCOUNT',
  'profile.tabRecover': 'RECOVER',
  // A guest's hero (it opens the sign-up form) and its tag
  'profile.registerFree': 'CREATE A FREE ACCOUNT',
  'profile.registerSlot': '30 s',
  // The link under the sign-in form
  'profile.forgot': 'Forgot your password?',
  // Separator above the Google / Discord buttons
  'profile.or': 'or',
  // provider: Google or Discord
  'profile.signInWith': 'Sign in with {provider}',
  'profile.username': 'Username',
  'profile.password': 'Password',
  'profile.signIn': 'SIGN IN',
  // Toast after signing in (password, Google or Discord: also src/game/Game.ts); {name} is the account name
  'profile.hello': 'Hi, {name}',
  // Placeholder of the username field: length and allowed characters
  'profile.usernameHint': '{min} to {max}: letters, numbers, _ - .',
  // Placeholder of the password field (PASSWORD_MIN, 8)
  'profile.passwordHint': { one: 'At least {count} character', other: 'At least {count} characters' },
  'profile.repeatPassword': 'Repeat password',
  'profile.passwordsDiffer': "The passwords don't match",
  'profile.createAccount': 'CREATE ACCOUNT',
  'profile.registered': 'All set, {name}! Your account is ready. These are your recovery codes:',
  'profile.recoveryCode': 'Recovery code',
  'profile.newPassword': 'New password',
  // Button of the recover form (with a recovery code)
  'profile.resetPassword': 'RESET PASSWORD',
  // count: recovery codes still unused
  'profile.passwordReset': { one: 'Password changed. {count} code left.', other: 'Password changed. {count} codes left.' },
  // PROFILE as a guest, under the sign-in forms; {name} is its name ('Guest 4821'): the server's, a new one with each guest session
  'profile.guestLine': "You're playing as {name}, a temporary name. With an account you choose your own.",
  'profile.loading': 'Loading…',
  // date: the sign-up date; providers: how the account signs in, e.g. 'password, Google'
  'profile.since': 'Member since {date} · {providers}',
  // Sign-in method in the providers list, lower case
  'profile.providerPassword': 'password',
  'profile.abandons': 'Matches abandoned in 24 h: {count}',
  // {minutes} is the time left on the Competitive lock, in whole minutes (rounded up)
  'profile.abandonsBanned': 'Matches abandoned in 24 h: {count} · Competitive locked for {minutes} min',
  'profile.season': 'SEASON {season}',
  'profile.account': 'ACCOUNT',
  // The folded account actions
  'profile.accountSecurity': 'Account and security',
  // A community node operator's section and its nodes
  'profile.myServer': 'MY SERVER',
  'profile.nodePending': 'Waiting for its first check',
  'profile.nodeProbation': 'On trial: {count} of {total} matches',
  'profile.nodeActive': 'Active',
  'profile.nodeSuspended': 'Paused',
  'profile.nodeBanned': 'Removed',
  'profile.nodeOffline': 'offline',
  'profile.nodeMatches': 'Matches hosted',
  'profile.nodeVersion': 'Version',
  'profile.nodeUpdate': '{version} · update it',
  'profile.community': 'COMMUNITY',
  // The Discord server speaks English
  'profile.discord': 'Discord (in English)',
  'profile.hostServer': 'Host a server',
  'profile.source': 'Source code',
  'profile.about': 'ABOUT',
  // {protocol}: the online protocol's number
  'profile.version': '{game} {version} · protocol {protocol}',
  'profile.rename': 'CHANGE NAME',
  'profile.changePassword': 'CHANGE PASSWORD',
  // For an account that signs in only with Google / Discord
  'profile.setPassword': 'SET PASSWORD',
  'profile.newCodes': 'NEW RECOVERY CODES',
  // provider: GOOGLE or DISCORD (upper case)
  'profile.link': 'LINK {provider}',
  // A provider on the account and when it was linked ({date}); without a date: linked before it was kept
  'profile.linkedOn': '{provider} · linked on {date}',
  'profile.linkedWith': '{provider} · linked',
  'profile.unlink': 'UNLINK {provider}',
  'profile.unlinkTitle': 'Unlink {provider}?',
  'profile.unlinkNote': "You won't be able to sign in to this account with {provider} any more.",
  'profile.unlinkConfirm': 'UNLINK',
  'profile.unlinked': '{provider} unlinked',
  // "Confirm it's you" before a change to how the account signs in (linking, unlinking, a first password)
  'profile.reauthTitle': "Confirm it's you",
  'profile.reauthNote': 'To change how you sign in, sign in again with one of your methods.',
  'profile.reauthWith': 'SIGN IN WITH {provider}',
  'profile.reauthConfirm': 'CONFIRM',
  // "Confirm it's you" for a change that needs the password (unlinking down to one way in): {providers} is the linked ones, "Discord" or "Google or Discord"
  'profile.reauthPasswordOnly': "{providers} isn't enough for this: use your password.",
  // Back in PERFIL after confirming: the change can be made now
  'profile.reauthDone': 'Done: you can make the change now',
  'profile.signOut': 'SIGN OUT',
  'profile.signedOut': 'Signed out',
  // PERFIL's devices (Security 3): every browser or TV signed in to the account, each one's sign-out
  'profile.devices': 'DEVICES',
  'profile.devicesTitle': 'Devices signed in',
  'profile.devicesNote': "If you don't recognise one, sign it out.",
  'profile.deviceBrowser': 'Browser',
  // A TV signed in with the phone (it plays, but changes nothing on the account)
  'profile.deviceTv': 'TV (with the phone)',
  // {date}: when the device signed in; {last}: its last use
  'profile.deviceWhen': 'Since {date} · last used {last}',
  'profile.deviceThis': 'this device',
  'profile.deviceSignOut': 'SIGN IT OUT',
  'profile.deviceSignedOut': 'That device is signed out',
  // Sign out on every device, this one too (any account: with Google or Discord as well)
  // PERFIL on a TV signed in with the phone: its limited scope in words
  'profile.tvScopeNote': 'This TV signed in with your phone: it plays with your account, but account changes (name, password, linking, redeeming) are made on the phone.',
  'profile.signOutAll': 'SIGN OUT ON EVERY DEVICE',
  'profile.signOutAllTitle': 'Sign out on every device?',
  'profile.signOutAllNote': 'Every device, this one too. Then you sign in again with your account.',
  'profile.signOutAllConfirm': 'SIGN OUT EVERYWHERE',
  'profile.signedOutAll': 'Signed out on every device',
  'profile.renameTitle': 'Change name',
  'profile.renameNote': 'You can change it once every 30 days.',
  'profile.newName': 'New name',
  'profile.yourPassword': 'Your password',
  'profile.renameConfirm': 'CHANGE',
  'profile.renamed': 'Name changed',
  'profile.cancel': 'CANCEL',
  'profile.changePasswordTitle': 'Change password',
  'profile.setPasswordTitle': 'Set a password',
  'profile.setPasswordNote': 'With a password you can also sign in with your username.',
  'profile.currentPassword': 'Current password',
  'profile.repeatNewPassword': 'Repeat new password',
  'profile.othersSignedOut': 'Your other devices will be signed out.',
  'profile.save': 'SAVE',
  'profile.noMatch': "They don't match",
  'profile.passwordUpdated': 'Password updated',
  'profile.newCodesTitle': 'New recovery codes',
  'profile.newCodesNote': 'Your old codes will stop working.',
  'profile.generate': 'GENERATE',
  'profile.newCodesIntro': 'Your new codes:',

  // mn-keypad (src/ui/components/keypad.ts): the on-screen keys of a TV remote or a controller.
  // The case and delete keys are drawn (abc / ABC, an arrow): these name them for a screen reader
  'keypad.case': 'Upper or lower case',
  'keypad.delete': 'Delete',
  'keypad.space': 'SPACE',
  'keypad.done': 'DONE',
  // PERFIL on a TV (src/ui/screens/tvSignIn.ts): sign in with the account open on a phone. {link}: turbo-gol.com/tv
  'tvsign.tile': 'SIGN IN WITH YOUR PHONE',
  'tvsign.tileSub': 'No typing on the TV',
  'tvsign.title': 'Sign in with your phone',
  'tvsign.line': 'Go to {link} with your account signed in and enter this code',
  // {time}: m:ss
  'tvsign.expiresIn': 'Expires in {time}',
  'tvsign.expired': 'The code expired',
  'tvsign.newCode': 'NEW CODE',
  'tvsign.cancel': 'CANCEL',
  'tvsign.starting': 'Getting a code…',
  'tvsign.qr': 'Scan to sign in on the TV',
  // The phone's /tv page (src/ui/screens/tvSignIn.ts installTvLink); {name}: the phone's account
  'tvlink.title': 'Sign in on the TV',
  'tvlink.codeLabel': 'TV code',
  'tvlink.enterCode': 'Type the code shown on the TV in front of you',
  'tvlink.continue': 'CONTINUE',
  'tvlink.ask': 'Sign in on the TV as {name}?',
  'tvlink.askNote': 'Confirm only if this code is on a TV in front of you right now. If someone sent it to you or asked you to type it, cancel: that TV would play as you.',
  // {place}: the TV's city, country code and network as Cloudflare saw its start ("Córdoba, AR · Telecom")
  'tvlink.where': 'The TV is in {place}.',
  'tvlink.whereUnknown': "We don't know where that TV is.",
  'tvlink.sameNetwork': "It's on your network.",
  'tvlink.otherCountry': "That TV is in another country than you: if it isn't yours, cancel.",
  'tvlink.confirm': 'CONFIRM',
  'tvlink.cancel': 'CANCEL',
  'tvlink.signInFirst': 'Sign in on this phone first, then confirm the TV.',
  'tvlink.signIn': 'SIGN IN',
  'tvlink.done': 'Done: the TV signs in in a moment',
  'tvlink.otherCode': 'ANOTHER CODE',
  // The anti-bot check wants an interaction (Turnstile): a sheet with the reason; CANCEL stops it
  'antibot.title': 'Quick check',
  'antibot.body': 'Cloudflare wants to make sure you are a person: answer the check on screen.',
  'antibot.bodyTv': "Cloudflare asks for a check a remote can't answer. Cancel and try again in a while.",
  'antibot.cancel': 'CANCEL',

  // Username and password problems by issue code (src/net/account.ts codes, shown by src/ui/screens/profile.ts)
  'account.issue.usernameMissing': 'Choose a username',
  // USERNAME_MIN / USERNAME_MAX (3, 16)
  'account.issue.usernameLength': 'The username must be {min} to {max} characters long',
  'account.issue.usernameChars': 'Use only letters, numbers, "_", "-" or "." (starting with a letter or number)',
  'account.issue.usernameReserved': 'That name is reserved',
  'account.issue.usernameDomain': 'The username can\'t look like a web address (like "name.com")',
  // PASSWORD_MIN (8)
  'account.issue.passwordShort': { one: 'The password must be at least {count} character', other: 'The password must be at least {count} characters' },
  // PASSWORD_MAX (128)
  'account.issue.passwordLong': { one: 'The password can be at most {count} character', other: 'The password can be at most {count} characters' },
  'account.issue.passwordCommon': 'That password is too common',
  'account.issue.passwordHasUsername': "The password can't contain your username",
  'account.issue.passwordHasEmail': "The password can't contain your email",
  'account.issue.passwordRepeated': "The password can't be a single repeated character",

  // Account client errors (src/net/AccountClient.ts)
  // OAuth (Google / Discord) round trip came back with #auth=error:cancelled; menu toast
  'auth.oauthCancelled': 'You cancelled the sign-in',
  // OAuth error already_linked: the Google / Discord account belongs to another player
  'auth.oauthAlreadyLinked': 'That account is already linked to another user',
  // OAuth error provider_disabled
  'auth.oauthDisabled': "That sign-in method isn't enabled",
  // OAuth error bad_state (the sign-in round trip took too long)
  'auth.oauthExpired': 'The sign-in expired, try again',
  // Any other OAuth error code
  'auth.oauthFailed': "Couldn't sign in, try again",
  // A link or a re-authentication started without a valid session in this browser
  'auth.oauthLinkExpired': 'Your session ended: sign in again and try once more',
  // The Turnstile challenge failed before sign-up
  'auth.antiBotFailed': 'Anti-bot check failed, try again',
  // Sign-in with an empty username or password
  'auth.empty': 'Enter your username and password',
  // An account action was attempted with no signed-in session
  'auth.signInFirst': 'Sign in first',

  // Lobby client errors (src/net/LobbyClient.ts)
  // Custom lobby socket closed: the host removed this player
  'net.lobby.closedKicked': 'The host kicked you from the lobby',
  // Custom lobby closed (idle or empty)
  'net.lobby.closedEnded': 'The lobby was closed',
  // Custom lobby reached its lifetime limit
  'net.lobby.closedExpired': 'The lobby expired',
  // The same player joined the lobby from another tab, this one was closed
  'net.lobby.closedReplaced': 'You opened the lobby in another tab',
  // Lobby socket closed for any other reason
  'net.lobby.closedLost': 'Lost connection to the lobby',
  // Creating / joining a lobby needs a guest session and it could not be created
  'net.lobby.sessionFailed': "Couldn't create the guest session",

  // Failed requests with no text of their own (accounts, lobbies, matchmaking)
  // A server error without a text for its code (the status goes to the console only)
  'error.server': 'Server error',
  // A request could not reach the server (offline, server down)
  'error.network': 'No connection to the server',
  // The server answered something this page does not understand
  'error.protocol': 'Unexpected response from the server',
  // Anything else that failed on this side
  'error.unexpected': 'Something went wrong, try again',

  // Server errors by code (src/i18n.ts serverText): error.<surface>.<code> is the text for the code
  // the server sends. The Spanish file keeps the server's own messages. "Generic" marks a code the
  // server sends with several texts (Spanish players see the server's one): keep those texts general.
  // Account forms: sign-up, sign-in, recovery, password, rename (server/src/accountRoutes.ts, AccountsDO.ts)
  // Generic: the server says which limit was hit
  'error.account.rate_limited': 'Too many attempts, wait a minute',
  // Generic: the server says which username rule failed
  'error.account.bad_username': 'Invalid username',
  'error.account.bad_password': 'Invalid password',
  'error.account.bad_credentials': 'Wrong username or password',
  // The account was created with Google / Discord and has no password
  'error.account.no_password': 'This account signs in with Google or Discord',
  'error.account.banned': 'Account suspended',
  'error.account.account_required': 'You need an account (not a guest)',
  // Renaming an account that has a password
  'error.account.password_required': 'Enter your password to change your name',
  'error.account.username_taken': 'That username is taken',
  // Too many failed sign-ins; the profile screen adds the seconds left (profile.retryAfter)
  'error.account.throttled': 'Too many attempts, wait a moment',
  'error.account.bad_recovery': 'Wrong username or recovery code',
  'error.account.rename_too_soon': 'You can change your name once every 30 days',
  // Physics presets (Settings > Experimental): the account already holds 10
  'error.account.too_many': '10 presets at most: delete one first',
  'error.account.bad_preset': 'Invalid preset',
  // The TV's sign-in with the phone (the /tv page's CONFIRM)
  'error.account.tv_code_wrong': "That code doesn't exist: check it on the TV",
  'error.account.tv_code_expired': 'The code expired: get a new one on the TV',
  'error.account.tv_code_used': 'That code was already used',
  // The server holds too many TV codes at once
  'error.account.busy': 'Too many codes right now, try again in a minute',
  // A TV signed in with the phone tried an account change (a credential, a link, redeeming, approving another TV)
  'error.account.tv_session': "A TV signed in with the phone can't do that: do it on your phone",
  // Linking, unlinking or a first password needs a sign-in from the last few minutes
  'error.account.reauth_required': "Confirm it's you: sign in again with your account",
  // The re-authentication came back with another Google / Discord account than this one's
  'error.account.reauth_mismatch': "That isn't the account you sign in with",
  // Linking a provider the account already has another identity of
  'error.account.provider_set': 'Your account already has another account of that provider: unlink it first',
  // Unlinking the only way left to sign in
  'error.account.last_method': "It's your only way to sign in: link another one first",
  'error.account.not_linked': "That account isn't linked",
  // A sign-in, sign-up or recovery whose anti-bot check (Turnstile) failed
  'error.account.turnstile_failed': 'Anti-bot check failed, try again',
  // The garage (src/ui/screens/garage.ts): equipping a car the account does not own, or no car
  'error.account.not_owned': 'That car is not yours yet',
  'error.account.bad_car': 'Unknown car',
  // Redeeming with server points (the garage)
  'error.account.unknown_item': 'That item does not exist',
  'error.account.bad_item': 'That item does not exist',
  'error.account.not_available': 'That item cannot be redeemed yet',
  'error.account.frozen': 'Redeeming is paused until a maintainer reviews your server',
  'error.account.insufficient': 'Not enough server points',
  'error.account.requires_matches': 'Your server needs a verified match first',
  // Custom lobbies: create, join, the lobby socket (server/src/index.ts, LobbyDO.ts, LobbyDirectoryDO.ts)
  // Generic: the server says what was attempted too often
  'error.lobby.rate_limited': 'Too many attempts, wait a minute',
  // Generic: the server says what is wrong with the name
  'error.lobby.bad_name': 'The lobby name must be 3 to 24 characters',
  // The title reads as a guest's name, the game's or its staff's (src/net/account.ts lobbyNameIssue)
  'error.lobby.name_reserved': 'That lobby name is not allowed',
  // Same text as custom.codeInvalid
  'error.lobby.bad_code': 'The code is 6 letters or numbers',
  'error.lobby.no_lobby': "There's no lobby with that code",
  'error.lobby.closed': 'That lobby no longer exists',
  'error.lobby.kicked': 'The host kicked you from this lobby',
  // Generic: a wrong password to join, or one of the wrong length (1 to 32) in the settings
  'error.lobby.bad_password': 'Invalid password',
  'error.lobby.full': 'The lobby is full',
  // Generic: the match is running, has started, or some players are still in the last one
  'error.lobby.busy': 'Wait for the match to end',
  'error.lobby.bad_team': 'Invalid team',
  'error.lobby.team_full': 'That team is full',
  // Generic: changing the settings, kicking or starting
  'error.lobby.not_host': 'Only the host can do that',
  // Changing to a mode with fewer slots than players in the lobby
  'error.lobby.too_many': 'Too many players for that mode',
  'error.lobby.start_failed': "Couldn't start the match, try again",
  // Generic: the server names the player
  'error.lobby.member_busy': 'A player is still in another match',
  // START while a member's socket is away (LobbyDO's grace, plan PR 12)
  'error.lobby.member_away': 'A player is reconnecting',
  'error.lobby.capacity': 'All servers are busy, try again in a minute',
  // The server switched matchmaking off (creating a lobby). Same text as error.queue.matchmaking_off
  // (Spanish players keep the generic error.server line here: src/i18n.ts SERVER_DETAIL_CODES)
  'error.lobby.matchmaking_off': 'Matchmaking is paused, try again later',
  // A guest joining (or creating) a lobby with experimental rules
  'error.lobby.account_required': 'Experimental lobby: sign in to join',
  // The host picked experimental rules while a guest is in the lobby
  'error.lobby.guests_present': 'Guests cannot play experimental rules: they must sign in or leave',
  // Experimental rules with the server connection, or a lobby with a single player
  'error.lobby.experimental_p2p_only': 'Experimental rules need a P2P match with at least 2 players',
  'error.lobby.bad_physics': 'Invalid rules',
  'error.lobby.too_many_lobbies': 'You already have open lobbies: close one before creating another',
  'error.lobby.start_cooldown': 'Wait a few seconds before starting again',
  'error.lobby.guest_length': 'Server matches with guests last up to 5 minutes: pick a shorter length or sign in',
  'error.lobby.short_password': 'The password needs 4 to 32 characters',
  'error.lobby.password_locked': 'Too many password attempts on this lobby, wait a few minutes',
  'error.lobby.password_attempts': 'Someone is trying passwords on your lobby: joining with the password is paused for a few minutes',
  // Matchmaking: Casual and Competitive searches (POST /api/queue, /api/rejoin, the guest session)
  'error.queue.rate_limited': 'Too many attempts, wait a minute',
  'error.queue.account_required': 'Sign in to play Competitive',
  // {time}: what is left of the lock, in the page language ('5 min', '24 hr')
  'error.queue.ranked_ban': 'Competitive locked for leaving matches: {time}',
  // The server still holds a match of this player that the game could not free
  'error.queue.active_match': "You're still in another match, try again in a moment",
  // {time}: what is left of the lock, in the page language ('5 min', '43 sec'). The player was placed in P2P matches and never joined them
  'error.queue.no_show': 'P2P matches locked for {time}: you skipped several matches you were placed in (server matches still work)',
  'error.queue.capacity': 'All servers are busy, try again in a minute',
  'error.queue.guest_limit': 'Too many guest matches from your network: sign in to play more',
  // The page is older than the server (after an update)
  'error.queue.reload_required': "There's a new version of the game: reload the page",
  // The server switched matchmaking off
  'error.queue.matchmaking_off': 'Matchmaking is paused, try again later',
  // The server switched new online matches off
  'error.queue.do_disabled': 'Online matches are paused, try again later',
  // The Turnstile anti-bot check failed (or could not run) before the search
  'error.queue.turnstile_failed': 'Anti-bot check failed, try again',
  'error.queue.turnstile_unconfigured': "The server's anti-bot check isn't set up, try again later",

  // Server match status lines (src/game/OnlineSession.ts), shown in the menu search banner
  'online.queue': 'Finding a match…',
  // count: players waiting in the queue
  'online.queueWaiting': { one: 'Finding a match… ({count} waiting)', other: 'Finding a match… ({count} waiting)' },
  'online.connecting': 'Connecting…',
  'online.waitingHost': 'Waiting for the host…',
  'online.reconnecting': 'Reconnecting…',
  // While the Turnstile anti-bot check runs (src/render/Hud.ts ONLINE_STATUS)
  'online.verifying': 'Checking that you are human…',
  // A server search answered with a P2P match (should never happen)
  'online.p2pAnswer': 'The server answered a server search with a P2P match',
  'online.cancelledDodge': 'Match cancelled: a player left before the start',
  'online.cancelledNoShow': "Match cancelled: a player didn't connect in time",
  // The match socket is gone for good (the close code goes to the console only)
  'online.connectionLost': 'Your connection dropped',
  // The HUD's top-centre line while the socket comes back; {n} of {max} tries
  'online.reconnectTry': 'Reconnecting… (attempt {n}/{max})',
  // For 1.5 s once it is back
  'online.back': 'Back in the match',
  // Joining a server match again (a lost connection's REJOIN, Inicio's BACK TO YOUR MATCH)
  'online.rejoining': 'Back to your match…',
  'online.matchOver': 'That match is over',
  // The host removed this player (the reason goes to the console only)
  'online.kicked': 'You were removed from the match',

  // P2P match status lines (src/net/p2p/P2PSession.ts), shown in the menu search banner and toasts
  'p2p.queue': 'Finding a match…',
  // count: players waiting in the queue
  'p2p.queueWaiting': { one: 'Finding a match… ({count} waiting)', other: 'Finding a match… ({count} waiting)' },
  'p2p.room': 'Joining the match…',
  // {connected} of {total} other players linked
  'p2p.connecting': 'Connecting to players… {connected}/{total}',
  'p2p.readyWait': 'Waiting for the other players…',
  // In-match hint: the player whose moves are late
  'p2p.waiting': 'Waiting for {name}…',
  // The P2P match could not start and a server match replaces it (fallback, nobodyLeft, serverAnswer)
  'p2p.fallback': "Couldn't connect to the players: playing on a server",
  'p2p.nobodyLeft': 'The other players left: playing on a server',
  'p2p.serverAnswer': 'No P2P opponents right now: playing on a server',
  'p2p.desync': 'Out of sync with the other players: match cancelled',
  'p2p.droppedMe': 'The match dropped you as disconnected',
  'p2p.requeue': "Couldn't join the match: finding another…",
  'p2p.lostRoom': 'Lost connection to the server and to a player',
  // Rare failures in the match setup, for bug reports (badSlots, slotGap, badSlot)
  'p2p.badSlots': { one: 'Room with {count} slot', other: 'Room with {count} slots' },
  'p2p.slotGap': 'Room with non-contiguous slots',
  'p2p.badSlot': 'Invalid player slot {slot}',
  // The physics engine failed (its error goes to the console only)
  'p2p.engine': 'The game engine failed: reload the page',
  // The room's socket closed (the code goes to the console only)
  'p2p.roomClosed': 'The match room closed',
  // An experimental lobby's match could not connect: there is no server match to fall back to
  'p2p.experimentalFailed': 'Could not connect the players: experimental matches have no server fallback',
  // A lobby's P2P room that never connected: back in the lobby (never the public queue)
  'p2p.lobbyFailed': 'Could not connect the players: back to the lobby',
  // The room refused this page: its arena does not run the lobby's rules
  'p2p.physicsMismatch': "Your game could not apply the lobby's rules: reload the page",

  // Leaderboard and the Competitive result dialog (src/ui/screens/leaderboard.ts)
  // Screen title (top bar / history)
  'board.screenTitle': 'Leaderboard',
  // Screen heading, uppercase
  'board.title': 'LEADERBOARD',
  'board.subtitle': "The season's best MMR (after the 5 placement matches).",
  'board.loading': 'Loading…',
  // Column header
  'board.colPlayer': 'Player',
  // Column header: the tier name (Gold II)
  'board.colTier': 'Rank',
  // Column header: matches played
  'board.colGames': 'Matches',
  // The rating column
  'board.colRating': 'MMR',
  // A row for a screen reader
  'board.rowLabel': '#{rank} {name}, {tier}, {mmr} MMR, {games} matches',
  // The button that scrolls to your row (X)
  'board.goToMe': 'GO TO MY POSITION',
  // A tab's rank while placing ({played} of {total} placement matches)
  'board.placementShort': 'Placement {played}/{total}',
  // The board did not load (a button)
  'board.failed': "Couldn't load it · RETRY",
  'board.empty': 'Nobody has finished placement in this playlist yet.',
  'board.playPlacement': 'Play your 5 placement matches',
  'board.signIn': 'Sign in to see your position',
  // Footer: placed players in this playlist and the season number
  'board.total': { one: '{count} ranked player · Season {season}', other: '{count} ranked players · Season {season}' },
  // No tier yet (placement matches not finished)
  'board.unranked': 'Unranked',
  'board.resultPending': 'Your Competitive result is still being calculated: check your profile.',
  // A match hosted on a community node is rated only after its replay is checked: shown once when
  // the result is not there after the usual wait (the menu keeps waiting, up to two minutes, and
  // shows it whenever the player is back in the menus), then if it still has not arrived
  'board.resultVerifying': 'Your Competitive result is being verified: it will show up here once it is ready.',
  'board.resultVerifyingSlow': 'Your Competitive result is still being verified: check your profile in a few minutes.',
  // The replay check of a community-node match failed or could not run: nobody was rated
  'board.voided': "The Competitive match couldn't be verified and didn't count",
  'board.notRated': "That match didn't count for your rank",
  'board.cancelled': "The Competitive match was cancelled and didn't count",
  // Dialog title; {playlist} is the mode name (One-on-one)
  'board.titleWin': 'VICTORY · {playlist}',
  // Dialog title; {playlist} is the mode name (One-on-one)
  'board.titleDraw': 'DRAW · {playlist}',
  // Dialog title; {playlist} is the mode name (One-on-one)
  'board.titleLoss': 'DEFEAT · {playlist}',
  // {tier} is a tier name (Gold II)
  'board.promoted': 'Promoted to {tier}!',
  // {tier} is a tier name (Gold II)
  'board.demoted': 'Demoted to {tier}',
  // Placement matches still to play
  'board.placementLeft': { one: 'Placement: {count} match left', other: 'Placement: {count} matches left' },
  'board.left': 'You left: it counts as a loss.',
  // {time} is a m:ss countdown (4:59)
  'board.leftBanned': 'You left: it counts as a loss and Competitive is locked for {time}.',
  // Dialog button, uppercase
  'board.continue': 'CONTINUE',

  // On-screen touch controls (src/input/TouchControls.ts): short labels on round buttons, uppercase
  // Holds jump: one tap jumps, a second one in the air double jumps or dodges
  'touch.jump': 'JUMP',
  'touch.boost': 'BOOST',
  // Powerslide on the ground, air roll in the air (while held)
  'touch.drift': 'DRIFT',
  // Toggles the ball camera (camera locked on the ball); keep it to about 4 letters
  'touch.cam': 'CAM',
  // Full-screen notice on a phone held upright: the game is played in landscape
  'touch.rotate': 'Turn your phone sideways to play',
  // The same notice over an online match, which goes on under it (translucent, the score above it)
  'touch.rotateLive': 'The match goes on: turn your phone',
  // Three cards before the first touch match, one at a time. Short: a card is about 420 x 170 on a
  // phone held sideways. {n} of {total} (1 / 3)
  'touch.cardStep': '{n} / {total}',
  // Tapping the card shows the next one, uppercase
  'touch.cardOk': 'GOT IT',
  // Card 1: the stick floats; it starts where the left thumb lands on the left half
  'touch.card1Title': 'The stick appears where your thumb lands',
  'touch.card1Text': 'Left half of the screen: push to drive, pull back to brake.',
  // Card 2: one thumb slides from BOOST onto JUMP or DRIFT and BOOST stays on
  'touch.card2Title': 'Slide from BOOST to keep it on',
  'touch.card2Text': 'JUMP is beside it; DRIFT turns the car in the air.',
  // Card 3: CAM toggles the ball camera; the pause button is top right; the score opens the teams
  'touch.card3Title': 'CAM follows the ball',
  'touch.card3Text': 'Pause is top right. Tap the score to see the teams.',
  // One-time menu toast on an iPhone, whose browser cannot go full screen: Safari's Share button,
  // then its "Add to Home Screen" item (use Safari's own names in your language); › joins the two steps
  'touch.installHint': 'Play full screen: tap Share › Add to Home Screen',

  // Controls card (src/render/controlsCard.ts): during the kickoff countdown of the first matches
  // and in free play, then a slim strip in a corner. Short: it shares the screen with the match.
  // Card title, uppercase
  'controls.title': 'CONTROLS',
  // Tag next to the title in the very first match, uppercase
  'controls.tagFirst': 'YOUR FIRST MATCH',
  // Tag next to the title in the next ones; {n} of {total} (2 of 3), uppercase
  'controls.tagMatch': 'MATCH {n} OF {total}',
  // Row names; the keys / buttons of the player's own bindings come after them
  'controls.drive': 'Drive',
  'controls.steer': 'Steer',
  'controls.jump': 'Jump',
  'controls.boost': 'Boost',
  'controls.ballCam': 'Ball cam',
  // Mouse buttons in words, next to a small mouse drawing
  'controls.mouseLeft': 'Left click',
  'controls.mouseRight': 'Right click',
  'controls.mouseMiddle': 'Wheel click',
  // Line under the rows; {tab} is settings.tabKbm or settings.tabPad
  'controls.change': 'Change them in Settings › {tab}',

  // In-match HUD (src/render/Hud.ts). Short: it shares a 375 px phone screen with the touch controls.
  // Scorebug team tags (top left, next to the score), uppercase, about 3 letters
  'hud.tagBlue': 'BLU',
  'hud.tagRed': 'RED',
  // Label over the boost bar (bottom left), uppercase
  'hud.boost': 'BOOST',
  // Camera pill at the bottom of the screen, uppercase: the camera stays on the ball
  'hud.ballCam': 'BALL CAM',
  // The same pill when the camera looks where the car goes
  'hud.carCam': 'CAR CAM',
  // Last step of the kickoff countdown (3, 2, 1, GO), huge, uppercase
  'hud.go': 'GO',
  // Team column headers of the scoreboard (held Tab / Back)
  'hud.teamBlue': 'Blue',
  'hud.teamRed': 'Red',
  // Scoreboard tag before a name, uppercase, about 3 letters: the player's own car
  'hud.you': 'YOU',
  // Scoreboard tag before a name: a car driven by the AI
  'hud.bot': 'BOT',
  // Scoreboard footer; {difficulty} is game.scoreboardEasy / Medium / Hard offline, game.scoreboardOnline / OnlineP2p online
  'hud.botDifficulty': 'Bot difficulty · {difficulty}',
  // The goal banner, huge, every goal
  'hud.goal': 'GOOOAL!',
  // The chip under it: "Blue 1 – 0 Red"
  'hud.goalScore': '{blueName} {blue} – {red} {redName}',
  // For a screen reader: who scored and the score, or the score alone
  'hud.goalBy': '{name} scores. Blue {blue}, Red {red}',
  'hud.goalLabel': 'Goal. Blue {blue}, Red {red}',
  // The feed (top centre) when you demolish a car; {count} is how many this match, uppercase
  'hud.demolished': 'DEMOLISHED · {count}',

  // Pause screen (src/render/Hud.ts)
  // Title, huge, uppercase
  'pause.title': 'PAUSED',
  // Line under the title; {resumeKeys} are key names (Esc / Start / B), not translated. Every one of
  // them resumes (B and Backspace too): only the QUIT button leaves the match.
  'pause.hintDefault': '{resumeKeys} to resume',
  // The same line with the player's pause keys; a mouse click on the game also resumes
  'pause.hint': '{resumeKeys} or click to resume',
  // Pause menu buttons (mouse, keys, controller and touch), uppercase
  // Back to the match
  'pause.resume': 'RESUME',
  // Opens the settings screen (controls, audio, graphics); BACK there returns to the pause menu
  'pause.settings': 'SETTINGS',
  // Experimental free play only: opens the settings screen on its Experimental tab (the physics preset)
  'pause.rules': 'RULES',
  // Leave the match for the menus
  'pause.quit': 'QUIT',
  // Online the match goes on behind the pause: the title says so (a dot before it), uppercase
  'pause.live': 'MATCH IN PROGRESS',
  // Under it
  'pause.liveSub': 'Your car stands still while this menu is open',
  // Under QUIT: it is held (controller A, Enter, a finger) to leave the match
  'pause.holdHint': 'Hold to leave',
  // The same with a mouse: a double click leaves
  'pause.dblHint': 'Double-click to leave',
  // Under QUIT in a Competitive match
  'pause.quitRanked': 'Counts as an abandon',

  // The final screen (src/ui/screens/match/final.ts), about 2 s after the whistle
  // Its slot's first word ("FINAL · COMPETITIVE · 2V2 · SOUTH AMERICA"), uppercase
  'final.slot': 'FINAL',
  // The result, huge, uppercase
  'final.win': 'VICTORY',
  'final.loss': 'DEFEAT',
  'final.draw': 'DRAW',
  // The kind of match in the slot and on PLAY AGAIN (Casual and Competitive use play.casualTitle / play.rankedTitle)
  'final.vsAi': 'VS AI',
  'final.lobby': 'Lobby',
  // For a screen reader: the card, then the score
  'final.label': 'Final: {outcome}, Blue {blue}, Red {red}',
  'final.scoreLabel': 'Blue {blue}, Red {red}. Your team is {team}',
  // The players table: its name for a screen reader, its column headers (uppercase)
  'final.players': 'Players',
  'final.colPlayer': 'PLAYER',
  'final.colGoals': 'GOALS',
  // The rank card (Competitive): its label, {mode} is 1V1 / 2V2 / 3V3
  'final.yourRank': 'YOUR RANK · {mode}',
  // While the server works the rating change out
  'final.rankWaiting': 'Working out your rank…',
  // For a screen reader, next to "+18" / "−12"
  'final.rankUp': 'Up {mmr} MMR',
  'final.rankDown': 'Down {mmr} MMR',
  // Under the bar: what the next tier still takes
  'final.toNext': '{mmr} MMR to {tier}',
  // The MVP card: its label (uppercase), then "Name · 2 goals"
  'final.mvpLabel': 'MVP · YOUR MATCH',
  'final.goals': { one: '{count} goal', other: '{count} goals' },
  // A match on a community server: its name, the tag (uppercase) and the rules
  'final.server': 'Server: {name}',
  'final.community': 'COMMUNITY SERVER',
  'final.rules': 'Standard rules',
  'final.rulesRanked': 'Standard rules · counts for your rank',
  // The main button: its slot (uppercase), the button, and its line for a lobby match
  'final.slotQueue': 'SAME QUEUE',
  'final.slotAi': 'REMATCH',
  'final.slotLobby': 'YOUR LOBBY',
  'final.again': 'PLAY AGAIN',
  'final.backToLobby': 'Back to the lobby',
  // The other two buttons (uppercase) and their lines
  'final.change': 'CHANGE MODE',
  'final.changeSub': 'Casual, VS AI or Lobbies',
  'final.menu': 'MENU',
  'final.menuSub': 'Back to Play',
  // The main button while a graphics pick waits for the FINAL (Super low: the game restarts first); {quality} = the tier's name
  'final.slotRestart': 'GRAPHICS',
  'final.restart': 'RESTART',
  'final.restartHome': 'Applies {quality} · back to Play',
  'final.restartLobby': 'Applies {quality} · back to the lobby',
  // A Competitive match that never started: the toast over Inicio while the search starts again
  'final.noShow': "A player didn't show up · back in the queue",
  'final.dodge': 'A player left before the start · back in the queue',

  // MATCH FOUND (src/ui/screens/match/found.ts): the band over any screen as a search finds a match, uppercase
  'found.title': 'MATCH FOUND',
  // The browser tab's title meanwhile
  'found.tab': 'Match found! · Turbogol',

  // Ajustes, from the menus and over the pause (src/ui/screens/settings/*): a rail of tabs (shown
  // uppercase), each tab's page of rows
  // Tab: the device sections below (bindings and their sensitivities)
  'settings.tabControls': 'Controls',
  // Controls' sections, one per device detected (also in controls.change)
  'settings.tabTouch': 'Touch',
  'settings.tabKbm': 'Keyboard & Mouse',
  'settings.tabPad': 'Controller',
  'settings.tabCamera': 'Camera',
  // Tab: sensitivities, deadzones and other control options
  'settings.tabGameplay': 'Gameplay',
  // Tab: sound volume
  'settings.tabAudio': 'Audio',
  // Tab: graphics quality
  'settings.tabGraphics': 'Graphics',
  // Tab: features being tested, for signed-in players (a guest's tab gets a lock and settings.signInShort under it)
  'settings.tabExperimental': 'Experimental',
  // The rail's name for a screen reader
  'settings.tabsLabel': 'Settings sections',
  // Over the rail, uppercase, beside the keys that step it
  'settings.section': 'SECTION',
  // Under a guest's Experimental tab
  'settings.signInShort': 'Sign in',
  // After a slider's value for a screen reader: its default ({value} with its unit)
  'settings.defaultValue': 'default {value}',
  // The − and + beside a slider, for a screen reader (the slider's name follows)
  'settings.less': 'Less',
  'settings.more': 'More',
  // After the default camera preset's name
  'settings.default': 'default',
  // Camera: the row of the named presets
  'settings.cameraPreset': 'Preset',
  // Over a device's binding list
  'settings.bindHelpPad': 'A changes · hold B to cancel · X clears',
  'settings.bindHelpKbm': 'Enter changes · Esc cancels · Del clears',
  // In settings.pressButton's {cancelKey}: hold the controller's B button
  'settings.holdB': 'hold B',
  // After a binding: another action already uses that key ({key} the key, {action} the other action)
  'settings.bindConflict': '{key} is also {action}',
  // Graphics cards: the running one's tag, uppercase; a heavy tier on a device with little memory
  'settings.qualityCurrent': 'CURRENT',
  'settings.qualityMemory': 'Needs memory',
  // After a tier was applied: keep it, or back to the one before ({quality}, uppercase) in {seconds}
  'settings.qualityKeep': 'KEEP',
  'settings.qualityRevert': 'BACK TO {quality}',
  'settings.qualityReverting': 'Back to {quality} in {seconds} s unless you keep it',
  'settings.qualityTrialNote': 'After you apply another quality you have 10 s to keep it; if not, it goes back by itself.',
  // Group titles of the binding lists (shown uppercase by the style)
  'settings.groupDriving': 'Driving',
  // Car controls while flying
  'settings.groupAir': 'Air',
  'settings.groupCamera': 'Camera',
  // Scoreboard, pause, reset and training shortcuts
  'settings.groupGame': 'Game',
  // One line over the keyboard & mouse list (cut with … when the screen is narrow)
  'settings.mouseNote': 'Mouse buttons and wheel are bindable · mouse movement swivels the camera',
  // Keyboard & Mouse tab, under the mouse note: the arrow keys are fixed second keys for driving
  'settings.arrowsNote': 'The arrow keys drive too, unless you bind them to something else',
  // Tooltip of the disabled × next to the pause binding
  'settings.pauseLockedTitle': 'Pause cannot be unbound',
  // The ✕ next to a binding, for a screen reader; {key} is the action's name
  'settings.unbindTitle': 'Unbind ({key})',
  // Inside the binding cell while it waits for the new key, lowercase; {cancelKey} is a key name (Esc)
  'settings.pressKey': 'press a key… ({cancelKey} cancels)',
  // The same on the controller tab
  'settings.pressButton': 'press a button… ({cancelKey} cancels)',
  // Footer button of the binding tabs: restore the standard bindings
  'settings.defaultLayout': 'Default layout',
  // Footer button of the keyboard tab: a bindings preset that uses no mouse buttons
  'settings.keyboardOnly': 'Keyboard only',
  // Controller tab status line; {name} is the browser's name for the gamepad
  'settings.padNamed': 'Controller: {name}',
  // The same when the browser gives no name
  'settings.padConnected': 'Controller: connected',
  // Browsers only report a gamepad after one of its buttons is pressed
  'settings.padMissing': 'No controller detected (press any button)',
  // Camera tab: line over the sliders (the camera behind the car)
  'settings.cameraNote': 'Chase camera',
  // Camera slider labels
  'settings.cameraFov': 'Field of view',
  'settings.cameraDistance': 'Distance',
  'settings.cameraHeight': 'Height',
  'settings.cameraAngle': 'Angle',
  // How tightly the camera follows the car
  'settings.cameraStiffness': 'Stiffness',
  // How fast the camera turns when you look around
  'settings.cameraSwivelSpeed': 'Swivel speed',
  // How fast it switches between ball cam and car cam
  'settings.cameraTransitionSpeed': 'Transition speed',
  // Camera preset buttons; {values} is field of view / distance / height (110/270/100)
  'settings.presetWide': 'Wide ({values})',
  'settings.presetClassic': 'Classic ({values})',
  // Gameplay tab: line over the rows
  'settings.gameplayNote': 'Sensitivities and deadzones',
  // Gameplay tab rows
  'settings.steeringSensitivity': 'Steering sensitivity',
  'settings.aerialSensitivity': 'Aerial sensitivity',
  // Stick movement ignored around the centre
  'settings.controllerDeadzone': 'Controller deadzone',
  // Stick tilt needed for a second jump to become a dodge (flip) instead of a double jump
  'settings.dodgeDeadzone': 'Dodge deadzone',
  'settings.mouseSensitivity': 'Mouse sensitivity',
  // On / off: steer the car with the mouse
  'settings.mouseSteering': 'Mouse steering',
  'settings.mouseSteeringSensitivity': 'Mouse steering sensitivity',
  // On / off: swap nose up / nose down while flying
  'settings.invertAirPitch': 'Invert air pitch',
  // On / off
  'settings.vibration': 'Controller vibration',
  // On / off, touch screens only: one thumb sliding from JUMP to BOOST keeps the jump held (a full jump for an aerial)
  'settings.touchHoldJump': 'Touch: keep JUMP held when sliding to BOOST',
  // Gameplay tab footer button: restore every row
  'settings.resetGameplay': 'Reset gameplay',
  // Audio tab: line over the rows
  'settings.audioNote': 'Game sounds',
  // Audio tab slider: the volume of every sound, 0-100 %
  'settings.volume': 'Master volume',
  // Audio tab slider: the volume of the music, 0-100 % (under the master volume)
  'settings.music': 'Music',
  // Audio tab footer button: the volumes back to their defaults
  'settings.resetAudio': 'Reset audio',
  // Graphics tab: line over the rows (a change shows the loading screen for a moment)
  'settings.graphicsNote': 'A quality change reloads the stadium for a moment',
  // Graphics tab row: the four tiers are quality.superlow / quality.low / quality.high / quality.ultra
  'settings.quality': 'Graphics quality',
  // Line under the quality row, for the tier that is selected
  'settings.qualitySuperlowHint': 'For TVs and very old devices: 30 fps, a simpler stadium (restarts the game)',
  'settings.qualityLowHint': 'Smoothest, for phones and older computers',
  'settings.qualityHighHint': 'Balanced detail and smoothness',
  'settings.qualityUltraHint': 'Every effect, for a powerful graphics card',
  // In place of the hint when the picked tier needs a restart (into or out of Super low) during an
  // online match: it waits until the player leaves the match
  'settings.qualityAfterOnline': 'Applies when you leave the online match (the game restarts)',
  // Into or out of Super low restarts the game, which would end the search
  'settings.qualityBusy': 'Stop searching to switch Super low on or off',
  // In place of the hint when the device runs Super low by itself (a weak TV, the safety net) and
  // the player cannot pick it: no tier is lit
  'settings.qualityAuto': 'This device runs Super low on its own',
  // Experimental tab (src/render/experimentalPage.ts). A guest sees only this line
  'settings.experimentalLocked': 'Sign in to try experimental features: custom physics in free play and P2P lobbies',
  // Line over the switch
  'settings.experimentalNote': 'Features being tested: they may change or go away',
  // The switch's label (settings.on / settings.off)
  'settings.experimentalSwitch': 'Experimental features',
  // Under the switch while it is on
  'settings.experimentalUnlocks': 'Unlocks Experimental free play and lobby rules',
  // Graphics tab: the group under the quality cards
  'settings.graphicsOptions': 'Options',
  // Graphics rows (the owner's Ajustes drawing), each with its help line
  'settings.resolutionScale': 'Resolution scale',
  'settings.resolutionScaleHelp': 'Lower is smoother; text and the HUD always stay sharp.',
  'settings.fpsCap': 'Frame rate limit',
  'settings.fpsCapHelp': 'Set it to 30 to save battery and heat.',
  // The frame limit's third option, uppercase
  'settings.fpsNone': 'NO LIMIT',
  'settings.menuScene': 'Animated stadium in the menus',
  'settings.menuSceneHelp': 'Turn it off so the menus use less battery.',
  // On / off for everyone: flat surfaces, no effects (a restart)
  'settings.superlow': 'Super low mode',
  'settings.superlowHelp': 'Flat surfaces and no effects, for very modest devices. Restarts the game.',
  // Graphics' head button: the options above back to their defaults (not the quality), uppercase
  'settings.resetGraphics': 'RESET GRAPHICS',
  // Game tab: the group of the interface rows
  'settings.groupInterface': 'Interface',
  // Game tab: the size of the menus' text and boxes (100 / 115 / 130 / 150 %)
  'settings.uiSize': 'Interface size',
  'settings.reducedMotion': 'Reduced motion',
  'settings.reducedMotionHelp': 'Nothing slides or bounces in the menus.',
  // Reduced motion's first option: follow the system's setting
  'settings.motionSystem': 'SYSTEM',
  // Controls > Touch rows: the buttons' size (S / M / L), their opacity, the mirrored layout,
  // where the stick starts (where the thumb lands / always in its place), its deadzone, vibration
  'settings.touchSize': 'Button size',
  'settings.touchOpacity': 'Opacity',
  'settings.touchLefty': 'Left-handed',
  'settings.touchLeftyHelp': 'Stick on the right, buttons on the left.',
  'settings.touchStick': 'Stick',
  'settings.touchStickFloating': 'FLOATING',
  'settings.touchStickFixed': 'FIXED',
  'settings.touchDeadzone': 'Stick deadzone',
  'settings.touchVibration': 'Vibrate on press',
  // The card under the settings rail: every change is saved at once, in this browser
  'settings.savedTitle': 'Saved automatically',
  'settings.savedGuest': 'As a guest, your settings stay in this browser.',
  'settings.savedAccount': 'Your settings stay in this browser.',
  // On / off switch of a row, uppercase (also in trainingHud.boost*)
  'settings.on': 'ON',
  'settings.off': 'OFF',

  // Bindable actions, one row each on the controls screen under the settings.group* titles
  // (src/input/bindings.ts ACTION_ROWS). Key and button names are never translated. Keep them short:
  // on a 375 px phone a label shares its row with a 128 px binding cell.
  'action.throttle': 'Throttle',
  'action.reverse': 'Reverse',
  'action.steerLeft': 'Steer left',
  'action.steerRight': 'Steer right',
  'action.jump': 'Jump',
  'action.boost': 'Boost',
  // The same action as the touch button touch.drift
  'action.powerslide': 'Powerslide',
  // In the air: nose up (stick pulled back)
  'action.pitchUp': 'Air pitch up',
  // In the air: nose down (stick forward)
  'action.pitchDown': 'Air pitch down',
  'action.yawLeft': 'Air yaw left',
  'action.yawRight': 'Air yaw right',
  // (hold): works while the key is held; the steer keys then roll the car instead of yawing
  'action.airRoll': 'Air roll (hold)',
  'action.airRollLeft': 'Air roll left',
  'action.airRollRight': 'Air roll right',
  // The camera that keeps the ball in view
  'action.ballCam': 'Ball cam',
  'action.rearView': 'Rear view',
  'action.lookLeft': 'Camera swivel left',
  'action.lookRight': 'Camera swivel right',
  'action.lookUp': 'Camera swivel up',
  'action.lookDown': 'Camera swivel down',
  'action.scoreboard': 'Scoreboard (hold)',
  'action.pause': 'Pause / menu',
  'action.reset': 'Reset to kickoff',
  // Training only: resets the shot in a pack, the ball in free play
  'action.trainingReset': 'Training: reset shot / ball',
  // Training packs only
  'action.trainingPrev': 'Training: previous shot',
  'action.trainingNext': 'Training: next shot',
  // Free play only: the car goes back to its spawn
  'action.trainingResetCar': 'Practice: reset car',
  // Free play only: turns unlimited boost on and off
  'action.trainingBoost': 'Practice: unlimited boost',

  // Experimental physics presets (src/game/physicsRules.ts, Settings > Experimental). Preset names
  // follow the lobby name rules (letters, digits, spaces and _ . - ! ? #, 3 to 24 characters):
  // rules.builtin.*, rules.defaultName and rules.copyName must keep to them (tests/i18n-lobby-name.test.mjs)
  'rules.preset': 'Rules',
  // Under a built-in preset in the picker
  'rules.builtIn': 'Built-in: duplicate it to edit',
  // Preset buttons
  'rules.new': 'New',
  'rules.duplicate': 'Duplicate',
  'rules.rename': 'Rename',
  'rules.delete': 'Delete',
  'rules.deleteConfirm': 'Delete? Press again',
  'rules.name': 'Name',
  // Automatic name of a new preset; {n} counts from 1
  'rules.defaultName': 'My rules {n}',
  // Name of a copy; {name} is the original's, {n} counts from 2
  'rules.copyName': '{name} #{n}',
  // Toasts
  'rules.full': '{max} presets at most: delete one first',
  'rules.offline': 'Saved on this device; it goes to your account when you are back online',
  'rules.deleteOffline': 'Deleting a preset needs a connection',
  'rules.reset': 'Reset to standard',
  // A row that only exists in free play (game speed)
  'rules.trainingOnly': 'Free play only',
  // Row groups
  'rules.groupWorld': 'World',
  'rules.groupBall': 'Ball',
  'rules.groupCar': 'Car',
  'rules.groupContact': 'Contact',
  // One row per value
  'rules.gravity': 'Gravity',
  'rules.gameSpeed': 'Game speed',
  'rules.ballMaxSpeed': 'Ball top speed',
  'rules.ballHit': 'Hit strength',
  'rules.ballWeight': 'Ball weight',
  'rules.ballBounce': 'Ball bounce',
  'rules.ballDrag': 'Air drag (ball)',
  'rules.carMaxSpeed': 'Car top speed',
  'rules.boostPower': 'Boost power',
  'rules.boostUse': 'Boost use',
  'rules.spawnBoost': 'Boost at kickoff',
  'rules.jumpPower': 'Jump power',
  'rules.unlimitedFlips': 'Unlimited flips',
  'rules.unlimitedDoubleJumps': 'Unlimited double jumps',
  'rules.bumpForce': 'Bump strength',
  'rules.demoMode': 'Demolitions',
  // The demolitions row's options
  'rules.demoNormal': 'Normal',
  'rules.demoContact': 'On contact',
  'rules.demoOff': 'Off',
  'rules.respawnDelay': 'Respawn time',
  // Names of the built-in presets
  'rules.builtin.standard': 'Standard',
  'rules.builtin.lowGravity': 'Low gravity',
  'rules.builtin.fastBall': 'Fast ball',
  'rules.builtin.bouncy': 'Bouncy',
  'rules.builtin.arcade': 'Arcade',
  // The editor (Settings > Experimental, while the switch is on): the title over the preset picker
  'rules.groupPresets': 'Physics presets',
  // Under the picker while one of the player's own presets is shown ({max} is 10)
  'rules.yours': 'Your presets: {count} of {max}',
  // What the preset on screen changes: {summary} is rules.standardPhysics or "Gravity 50% · Air drag (ball) 50%"
  'rules.changes': 'Changes: {summary}',
  'rules.standardPhysics': 'Standard physics',
  // Ends a summary that lists only some of the changes
  'rules.more': '+{count} more',
  // Under each value's name: its standard value ({value} is written like the value: 100%, 216 km/h, 3 s)
  'rules.standardValue': 'Standard {value}',
  'rules.kmh': '{value} km/h',
  // Respawn time, in seconds
  'rules.seconds': '{value} s',
  // Boost use at 0%: the boost never runs out
  'rules.boostEndless': 'Endless',
  // In experimental free play (the pause menu's RULES): when the picked preset takes effect
  'rules.appliesOnClose': 'Free play restarts with these rules when you go back',
  // A preset name the lobby name rules refuse
  'rules.badName': 'Names: 3 to 24 letters, digits, spaces and _ . - ! ? #',
  // Reset to standard after one press: a second one resets every value
  'rules.resetConfirm': 'Reset to standard? Press again',

  // Training screen and packs (src/ui/screens/training.ts, src/game/trainingPacks.ts)
  // Screen title (top bar / history)
  'training.screenTitle': 'Training',
  // Screen heading, uppercase
  'training.title': 'TRAINING',
  // The subtitle on a keyboard or a controller: {reset} and {car} are the live keys of that device, e.g. "Backspace", "F" or "D-pad ↓", "D-pad ↑"
  'training.subKeys': '{reset} resets the shot · {car} resets the car',
  // The subtitle on a touch screen (↺ is the training's reset button)
  'training.subTouch': 'Tap ↺ to reset the shot',
  // Subtitle of the Free play tile
  'training.freePlayText': 'You, the ball and unlimited boost',
  // Under the Free play hero's title
  'training.freePlaySub': 'No clock',
  // The Shooting tile's tag (the pack to start with)
  'training.startHere': 'START HERE',
  // A pack's level mark, for a screen reader ({level}: Beginner...)
  'training.markDone': '{level}: passed',
  'training.markTried': '{level}: best {best}/{total}',
  'training.markNone': '{level}: not played',
  // A level in the pack sheet
  'training.packLine': { one: '{count} shot · {seconds} s per shot', other: '{count} shots · {seconds} s per shot' },
  // The tile (and the sheet) with every control of the device in use
  'training.howTo': 'How to play',
  'training.howToSub': 'Every control',
  'training.howKbm': 'Keyboard and mouse',
  'training.howPad': 'Controller',
  'training.howTouch': 'Touch',
  'training.howResetShot': 'Reset the shot',
  'training.howResetCar': 'Reset the car',
  // The touch reset button, as drawn
  'training.howResetTouch': '↺',
  'training.howStick': 'Stick',
  'training.howStickWhere': 'Drive and steer: the left half of the screen',
  'training.howBoostSlide': 'Boost: slide from it to keep it on',
  // Experimental free play's tile (accounts with Settings › Experimental on)
  'training.tagLab': 'LAB',
  // Under the Shooting category
  'training.shootingText': 'Shoot at the rival goal',
  // Under the Saving category
  'training.savingText': 'Stop the shots at your goal',
  // Under the Aerials category
  'training.aerialText': 'High balls: jump and fly',
  // Best run: shots passed / shots in the pack
  'training.best': 'Best: {best}/{total}',
  'training.notPlayed': 'Not played',
  // Mode name; the menu tile shows it uppercased
  'training.freePlay': 'Free play',
  // Signed-in players with Settings > Experimental on: free play with a physics preset (the tile
  // shows it uppercased, with the tag), the preset picker and the button to the preset editor
  'training.expFreePlay': 'Experimental free play',
  'training.expFreePlayText': 'Free play with your own physics',
  // The LAB tile's line where the long one has no room (a larger interface size)
  'training.expFreePlayShort': 'Your own physics',
  'training.editPresets': 'Edit presets',
  // Pack category
  'training.catShooting': 'Shooting',
  // Pack category
  'training.catSaving': 'Saving',
  // Pack category
  'training.catAerial': 'Aerials',
  // Pack difficulty
  'training.levelEasy': 'Beginner',
  // Pack difficulty
  'training.levelMedium': 'Intermediate',
  // Pack difficulty
  'training.levelHard': 'Expert',
  // Pack name: Shooting · Beginner
  'training.packName': '{category} · {difficulty}',

  // Training shot names, shown in the training HUD; each is unique within its pack (src/game/trainingPacks.ts)
  'training.shotOpenGoal': 'Open goal',
  'training.shotLeftLane': 'Left lane',
  'training.shotRightLane': 'Right lane',
  'training.shotBouncingBall': 'Bouncing ball',
  'training.shotComingBack': 'Ball coming back',
  'training.shotSlowCross': 'Slow cross',
  'training.shotTightAngle': 'Tight angle',
  'training.shotFromMidfield': 'From midfield',
  'training.shotCrossLeft': 'Cross from the left',
  'training.shotCrossRight': 'Cross from the right',
  'training.shotPopUp': 'Pop-up',
  'training.shotReturnPass': 'Return pass',
  'training.shotBouncePass': 'Bounce pass',
  'training.shotTurnaround': 'Turnaround',
  'training.shotOffTheWall': 'Off the wall',
  // Used by two packs (shooting-hard and aerial-hard)
  'training.shotFastCross': 'Fast cross',
  'training.shotHighBounce': 'High bounce',
  'training.shotBackDrop': 'Drop at the back',
  'training.shotRunawayBall': 'Runaway ball',
  'training.shotLobFromWing': 'Lob from the wing',
  'training.shotMovingStart': 'Moving start',
  'training.shotRollingMiddle': 'Rolling down the middle',
  'training.shotRollingLeftPost': 'Rolling to the left post',
  'training.shotRollingRightPost': 'Rolling to the right post',
  'training.shotBouncingIn': 'Bouncing in',
  'training.shotSoftLob': 'Soft lob',
  'training.shotRollingFromWing': 'Rolling from the wing',
  'training.shotLowShot': 'Low shot',
  'training.shotHopMiddle': 'Hop down the middle',
  'training.shotHardRoller': 'Hard roller',
  'training.shotLobTopCorner': 'Lob to the top corner',
  'training.shotShotFromWing': 'Shot from the wing',
  'training.shotBouncingShot': 'Bouncing shot',
  'training.shotChip': 'Chip shot',
  'training.shotFarPost': 'Far post',
  'training.shotLateDrop': 'Late drop',
  // A one-on-one against the keeper, not the playlist name
  'training.shotBreakaway': 'Breakaway',
  'training.shotTopCorner': 'Top corner',
  'training.shotLongLob': 'Long lob',
  'training.shotCrossingVolley': 'Crossing volley',
  'training.shotFastLow': 'Fast and low',
  'training.shotOutOfPosition': 'Out of position',
  'training.shotFloater': 'Floater',
  'training.shotLeftFloater': 'Left floater',
  'training.shotRightFloater': 'Right floater',
  'training.shotFallingBall': 'Falling ball',
  'training.shotDriftingBack': 'Ball drifting back',
  'training.shotCrossingFloater': 'Crossing floater',
  'training.shotHighFloater': 'High floater',
  'training.shotClosePopUp': 'Close pop-up',
  'training.shotFloatingCross': 'Floating cross',
  'training.shotCeilingDrop': 'Ceiling drop',
  'training.shotDeepFloater': 'Deep floater',
  'training.shotHighPopUp': 'High pop-up',
  'training.shotCornerPass': 'Pass from the corner',
  'training.shotRetreating': 'Retreating',
  'training.shotDoubleDrop': 'Double drop',
  'training.shotCeilingBall': 'Ceiling ball',
  'training.shotFarPostFloater': 'Far-post floater',
  'training.shotHighDeep': 'High and deep',
  'training.shotLongRange': 'Long range',
  'training.shotLobFromCorner': 'Lob from the corner',

  // Training HUD: shot panel, pause panel, pack summary (src/render/TrainingHud.ts)
  // Prompt while a shot waits for the first car input (one line, no wrap; on a phone it sits between
  // the touch stick and the JUMP button, so keep it no longer than the English)
  'trainingHud.start': 'Drive to start the shot',
  // Pause menu button (shot packs): restart the current shot
  'trainingHud.resetShot': 'Reset shot',
  // Pause menu buttons (shot packs)
  'trainingHud.prevShot': 'Previous shot',
  'trainingHud.nextShot': 'Next shot',
  // Pause menu button (free play): the ball back to the centre spot
  'trainingHud.resetBall': 'Reset ball',
  // Pause menu button (free play): the car back to its spawn
  'trainingHud.resetCar': 'Reset car',
  // Pause menu toggle button (free play) while unlimited boost is on; ON / OFF as in settings.on / settings.off
  'trainingHud.boostButtonOn': 'Unlimited boost: ON',
  // The same button while unlimited boost is off
  'trainingHud.boostButtonOff': 'Unlimited boost: OFF',
  // Pause menu button: leave training for the menu
  'trainingHud.quit': 'Quit training',
  // Experimental free play: the preset's name under the title
  'trainingHud.rulesLine': 'Rules: {name}',
  // Pack summary title
  'trainingHud.packComplete': 'Pack complete',
  // The pack summary's buttons
  'trainingHud.again': 'AGAIN',
  'trainingHud.nextLevel': 'NEXT LEVEL',
  'trainingHud.toTraining': 'TRAINING',
  // Key hints in the panel, one line each. {key} is a key/button name and is not translated. Keep the spacing.
  'trainingHud.keyResetBall': '{key}  reset ball',
  'trainingHud.keyResetCar': '{key}  reset car',
  // Toggles unlimited boost (free play)
  'trainingHud.keyBoost': '{key}  unlimited boost',
  'trainingHud.keyPause': '{key}  pause',
  'trainingHud.keyResetShot': '{key}  reset shot',
  // {prev} and {next} are key/button names
  'trainingHud.keyPrevNext': '{prev} / {next}  previous / next shot',
  // Key hints under the pack summary. The {...} are key/button names and are not translated. Keep the spacing.
  'trainingHud.summaryHint': '{reset}  again   ·   {back}  training   ·   {prev} / {next}  pick a shot',
  // The same with a controller (its D-pad walks the buttons)
  'trainingHud.summaryHintPad': '{reset}  again   ·   {back}  training',
  // The same with a TV remote: {accept} is its OK, {back} its Back (↩)
  'trainingHud.summaryHintRemote': '{accept}  choose   ·   {back}  training',
  // The run's hits and misses under the shot dots
  'trainingHud.tally': '✓ {hits}  ·  ✕ {misses}',
  // The panel's hints on a touch screen
  'trainingHud.touchResetAll': '{key}  reset car and ball',
  'trainingHud.touchPausePack': 'Pause: previous / next shot',
  'trainingHud.touchPauseFree': 'Pause: unlimited boost',
  // Panel: current shot number out of the pack's shots, then the shot's name (training.shot* keys)
  'trainingHud.shot': 'Shot {index} / {total}  ·  {name}',
  // Panel: tries at the current shot so far
  'trainingHud.attempts': { one: '{count} attempt', other: '{count} attempts' },
  // Panel status line (free play) while unlimited boost is on. Keep the spacing.
  'trainingHud.boostLineOn': 'Unlimited boost  ON',
  // The same line while unlimited boost is off
  'trainingHud.boostLineOff': 'Unlimited boost  OFF',
  // Pack summary: this run beat the saved best score
  'trainingHud.newBest': 'New best!',
  // Pack summary: saved best score, shots passed out of the pack's total. Keep the spacing.
  'trainingHud.best': 'Best  {best} / {total}',

  // Match banners, scoreboard rows and menu toasts (src/game/Game.ts)
  // In-match hint while mouse look is available but the mouse is not captured (pointer lock)
  'game.pointerLockHint': 'Click to capture the mouse (mouse look)',
  // Goal banner title in a match, and the training result title for a scored shot / free-play goal
  'game.goal': 'GOAL!',
  // Training result title: the shot was saved (saving packs)
  'game.trainingSave': 'SAVED!',
  // Training result title: the player put the ball in their own goal
  'game.trainingOwnGoal': 'OWN GOAL',
  // Training result title: the shot went into the player's goal (saving packs)
  'game.trainingConceded': 'CONCEDED',
  // Training result title: the shot's time limit ran out
  'game.trainingTimeUp': 'TIME UP',
  // Training result sub line: shot number of the pack's total, and which attempt this was (an ordinal, not a count). Keep the spacing.
  'game.trainingShot': 'Shot {shot} / {total}  ·  attempt {attempt}',
  // Team names inside sentences ({team} in game.teamScores and game.resultWin)
  'game.teamBlue': 'Blue',
  'game.teamRed': 'Red',
  // Team names in the uppercase end-of-match banner ({team} in game.teamWins)
  'game.teamBlueUpper': 'BLUE',
  'game.teamRedUpper': 'RED',
  // Goal banner sub line: {team} is game.teamBlue / game.teamRed, then the new score blue – red. Keep the spacing.
  'game.teamScores': '{team} scores  ·  {blue} – {red}',
  // End-of-match banner title; {team} is game.teamBlueUpper / game.teamRedUpper
  'game.teamWins': '{team} WINS',
  // End-of-match banner title when nobody won (server matches)
  'game.draw': 'DRAW',
  // Banner title when regulation time ends tied
  'game.overtime': 'OVERTIME',
  // Overtime banner sub line
  'game.nextGoalWins': 'Next goal wins',
  // Banner when a player joins a server match; {name} is the player's name
  'game.playerJoined': '{name} joined',
  // Banner when a player leaves a server match; {name} is the player's name or game.playerSlot
  'game.playerLeft': '{name} left',
  // Name of a player whose name is unknown; {slot} is the slot number
  'game.playerSlot': 'Player {slot}',
  // Banner when a peer-to-peer player drops out; {name} is the player's name
  'game.playerDisconnected': '{name} disconnected',
  // Sub line under game.playerDisconnected / game.playerLeft: a bot now drives that player's car
  'game.botTakeover': 'The AI takes over their car',
  // Scoreboard row of the local player in an online match; {name} is their name
  'game.nameYou': '{name} (You)',
  // Scoreboard row name of the local player in an offline match
  'game.you': 'You',
  // Scoreboard row name of an offline bot; {number} counts the bots of that team from 1
  'game.botName': 'Bot {number}',
  // Scoreboard footer values ({difficulty} in hud.botDifficulty), lowercase: the AI difficulty offline...
  'game.scoreboardEasy': 'easy',
  'game.scoreboardMedium': 'medium',
  'game.scoreboardHard': 'hard',
  // ...a server match
  'game.scoreboardOnline': 'online',
  // ...a peer-to-peer match
  'game.scoreboardOnlineP2p': 'online (P2P)',
  // Menu toast after a match; {team} is game.teamBlue / game.teamRed, {result} the final score (blue – red) or why the match ended. Keep the spacing.
  'game.resultWin': '{team} wins  ·  {result}',
  // Menu toast after a drawn match; {result} as in game.resultWin
  'game.resultDraw': 'Draw  ·  {result}',
  // Toast after creating an account with Google / Discord; {name} is the new account name. The profile opens right after
  'game.welcomeNew': 'Welcome, {name}! You can change your name in your profile.',
  // Toast after linking a Google / Discord login to the signed-in account
  'game.accountLinked': 'Account linked',
  // Guest name in the menus before the first guest session (and without an online server); online the server names the guest, shown as guest.name ('Guest 4821')
  'game.guestName': 'Guest',

  // Error page that replaces the loading screen when the game cannot start (src/main.ts). The error
  // details (stack) are not translated.
  'boot.rendererFailed': 'Could not start the renderer',
  // Keep the browser names and versions as they are
  'boot.rendererHint': 'This game needs WebGPU (Chrome / Edge 113+, Firefox 141+, Safari 26+) or at least WebGL2. Make sure hardware acceleration is enabled in the browser settings.',
  'boot.physicsFailed': 'Could not load the physics module',
  'boot.physicsHint': 'The WebAssembly module (rocketsim.wasm) failed to load or instantiate.',
  'boot.failed': 'Failed to start',
  'boot.failedHint': 'Something went wrong while starting the game.',

  // Loading screen (src/ui/LoadingOverlay.ts): one short line under the TURBOGOL wordmark and the
  // progress bar, shown uppercase. Keep them short and plain (no technical words).
  // Boot, first part (graphics and the stadium's sky); also a stadium change
  'loading.stadium': 'Loading stadium…',
  // Boot, second part (physics, the pitch and the cars)
  'loading.pitch': 'Setting up the pitch…',
  // Boot, last part (preparing the graphics so the first match runs smoothly)
  'loading.ready': 'Almost ready…',
  // A graphics quality change (Settings > Graphics)
  'loading.quality': 'Applying graphics quality…',
  // Switching into or out of Super low restarts the page (its own renderer)
  'loading.restart': 'Restarting with the new graphics quality…',
  // Replays (replay.html): the community servers' recorded matches, re-simulated in the browser
  'profile.replays': 'Replays',
  'replay.title': 'Replays',
  'replay.heading': 'REPLAYS',
  'replay.intro': 'Matches played on the community servers in the last 30 days.',
  'replay.back': 'Back to the game',
  'replay.loading': 'Loading…',
  'replay.empty': 'No replays yet. Play a match on a community server and it shows up here.',
  'replay.unavailable': 'Replays are not available on this server.',
  'replay.error': 'Could not load the replays.',
  'replay.retry': 'RETRY',
  'replay.more': 'LOAD MORE',
  'replay.watch': 'WATCH',
  'replay.openFile': 'Open a replay file',
  'replay.ranked': 'Competitive',
  'replay.casual': 'Casual',
  'replay.verified': 'Verified',
  'replay.unverified': 'Not verified',
  'replay.otherVersion': 'Other version',
  'replay.bot': 'Bot',
  'replay.preparing': 'Preparing the replay…',
  'replay.notFound': 'This replay is no longer available.',
  'replay.bad': 'This file is not a valid replay.',
  'replay.gpuLost': 'The graphics device stopped. Reload the page to watch the replay again.',
  'replay.buildWarning': 'This match was played on another version of the game: the replay may not show what really happened.',
  'replay.diverged': 'From {time} on, the replay no longer matches the recorded match.',
  'replay.checked': 'Checked against the recording',
  'replay.camera': 'Camera',
  'replay.broadcast': 'Broadcast',
  'replay.speed': 'Speed',
  'replay.play': 'Play',
  'replay.pause': 'Pause',
  'replay.list': 'All replays',
  'replay.keys': 'Space: play or pause · ← →: 5 s · 0-{max}: camera',
} satisfies Messages;
