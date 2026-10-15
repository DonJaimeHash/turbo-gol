/**
 * English: the source of truth for every text in the game (src/i18n.ts). To translate, copy this
 * file to src/locales/<code>.ts and follow CONTRIBUTING.md ("Translating"). Keep each key and its
 * {placeholders}; plural texts list the forms of Intl.PluralRules ('one', 'other'...).
 */
import type { Messages } from '../i18n';

export default {
  // Language picker
  'lang.title': 'Language',
  'lang.auto': 'Automatic ({language})',
  'lang.busy': 'Stop searching or leave the lobby to change the language',
  // Closes the language picker without a change
  'lang.cancel': 'CANCEL',

  // Names of shared ids (src/ui/names.ts)
  'playlist.1v1': 'One-on-one',
  'playlist.2v2': 'Pairs',
  'playlist.3v3': 'Trios',
  'region.SA': 'South America',
  'region.NA': 'North America',
  'region.EU': 'Europe',
  'region.AS': 'Asia',
  'region.OC': 'Oceania',
  'region.AF': 'Africa',
  'difficulty.easy': 'Easy',
  'difficulty.medium': 'Normal',
  'difficulty.hard': 'Hard',
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
  // Footer link to the game's source code. The AGPL-3.0 requires this link in every language: never drop it.
  'menu.source': 'Source code',
  // Tooltip of the source link; {license} is the license id (AGPL-3.0)
  'menu.sourceTitle': 'Source code ({license})',
  // Footer link to the third-party licenses file
  'menu.licenses': 'Licenses',
  // Tooltip of the footer Discord link. The community server speaks English, so other languages may say so, as the Spanish does
  'menu.discordTitle': 'Community on Discord',
  // Key hints in the bottom bar on the home screen. The {...Keys} are key/button names and are not translated. Keep the spacing.
  'menu.hints': '{moveKeys}  move   ·   {selectKeys}  select',
  // Key hints in the bottom bar on every other screen (adds back)
  'menu.hintsBack': '{moveKeys}  move   ·   {selectKeys}  select   ·   {backKeys}  back',
  // Top-bar account chip, under the player name, when signed in with no rank yet
  'menu.account': 'Account',
  // Top-bar account chip, under the guest name
  'menu.guestSignIn': 'Guest · Sign in',
  // Top bar: players in a match in the selected region
  'menu.playing': { one: '{count} playing', other: '{count} playing' },
  // Top-bar region when set to automatic, before the server has said which region
  'menu.regionAuto': 'Auto',
  // Top-bar region when set to automatic; {region} is the detected region's name
  'menu.regionAutoNamed': 'Auto · {region}',
  // Matchmaking banner: the kind of search
  'menu.searchRanked': 'COMPETITIVE',
  // Matchmaking banner: the kind of search
  'menu.searchCasual': 'CASUAL',
  // Matchmaking banner button that stops the search
  'menu.searchCancel': 'CANCEL',

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

  // Home screen (src/ui/screens/play.ts)
  // Home screen title (breadcrumb)
  'home.title': 'Home',
  // Home tile and heading of the Play hub
  'home.play': 'PLAY',
  'home.playSub': 'Casual · Competitive · Lobbies · Friendly',
  'home.training': 'TRAINING',
  'home.trainingSub': 'Free play and shot packs',
  'home.leaderboard': 'LEADERBOARD',
  'home.leaderboardSub': "The season's best",
  'home.profile': 'PROFILE',
  'home.profileSub': 'Account, ranks and stats',
  'home.settings': 'SETTINGS',
  'home.settingsSub': 'Controls, camera and graphics',
  // Home tile that opens the language picker; its subtitle is the current language's own name
  'home.language': 'LANGUAGE',
  // {season} is the season number; shown uppercase by CSS
  'home.season': 'Season {season}',
  'home.loadingProfile': 'Loading your profile…',
  'home.guestTitle': 'Play Competitive',
  // {playlist1}..{playlist3} are the playlist names (playlist.1v1, playlist.2v2, playlist.3v3)
  'home.guestText': 'Create an account to get a rank in {playlist1}, {playlist2} and {playlist3}. As a guest you can play Casual, custom lobbies and training.',
  // Button on the home side panel and on the locked Competitive screen
  'home.signIn': 'SIGN IN / CREATE ACCOUNT',

  // Play hub, Casual and Competitive (src/ui/screens/play.ts)
  // Play hub title (breadcrumb)
  'play.title': 'Play',
  // Play hub tile and Casual screen heading
  'play.casual': 'CASUAL',
  'play.casualSub': 'Unranked · P2P or server',
  // Play hub tile and Competitive screen heading
  'play.ranked': 'COMPETITIVE',
  'play.rankedSub': 'Rank per playlist · server',
  'play.custom': 'CUSTOM LOBBIES',
  'play.customSub': 'Public and private lobbies',
  // Play hub tile and Friendly screen heading
  'play.friendly': 'FRIENDLY',
  'play.friendlySub': 'Offline against the AI',
  // Players searching for a match right now
  'play.searching': { one: '{count} searching', other: '{count} searching' },
  // Open custom lobbies
  'play.lobbies': { one: '{count} lobby', other: '{count} lobbies' },
  // Corner tag of the Competitive tile for guests: an account is needed
  'play.accountLocked': '🔒 Account',
  // {region} is the matchmaking region label ('Auto · Europe')
  'play.playingNow': { one: '{region} · {count} playing now', other: '{region} · {count} playing now' },
  // {playlist} is the mode id ('2v2'), {count} the cars on the field
  'play.playlistCars': { one: '{playlist} · {count} car', other: '{playlist} · {count} cars' },
  'play.search': 'FIND MATCH',
  'play.cancelSearch': 'CANCEL SEARCH',
  // A search of the other kind (Casual / Competitive) is running
  'play.cancelOtherSearch': 'CANCEL OTHER SEARCH',
  'play.connection': 'Connection',
  'play.netP2p': 'P2P (recommended)',
  'play.netServer': 'Server',
  'play.casualIntro': 'Quick unranked matches. Pick one or more playlists: you join whichever finds a match first.',
  'play.playlists': 'PLAYLISTS',
  'play.options': 'OPTIONS',
  'play.casualNote': 'P2P: cars sync directly between players (less lag within one region). If nobody else is searching, you play against bots on a server.',
  // Casual screen title (breadcrumb)
  'play.casualTitle': 'Casual',
  // Still in placement matches
  'play.unranked': 'Unranked',
  // Placement matches played / needed
  'play.placement': 'Placement {games}/{total}',
  'play.mmr': '{mmr} MMR',
  // The ban lengths grow with each abandon (src/net/rating.ts ABANDON_BANS_MS)
  'play.rankedNote': 'Competitive is played on authoritative servers. The first 5 matches of each playlist are placement matches. Leaving a match counts as a loss and locks Competitive (5 min, 15 min, 1 h, 24 h).',
  'play.rankedNeedsAccount': 'Competitive needs an account',
  'play.rankedGuestText': 'Guests have no rank. Create a free account (username and password, or Google / Discord if enabled) and start your placement matches.',
  'play.rankedIntro': 'One rank per playlist. Your MMR goes up or down depending on who you beat.',
  // {time} is a live m:ss countdown
  'play.rankedBan': 'Competitive locked for leaving matches: {time}',
  // Competitive screen title (breadcrumb)
  'play.rankedTitle': 'Competitive',

  // Friendly match (src/ui/screens/play.ts)
  // Friendly screen title (breadcrumb)
  'friendly.title': 'Friendly',
  'friendly.mode': 'Mode',
  'friendly.difficulty': 'AI difficulty',
  'friendly.quality': 'Graphics quality',
  'friendly.qualityHigh': 'High',
  'friendly.qualityPerformance': 'Performance',
  'friendly.intro': 'A 5-minute offline match against the AI. Your teammates, if any, are bots too.',
  'friendly.match': 'MATCH',
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
  'custom.heading': 'CUSTOM LOBBIES',
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
  // Breadcrumb title of the lobby browser
  'custom.screenTitle': 'Custom lobbies',
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
  // Default lobby name; {name} is the player (up to 16 characters). The server keeps only letters, digits, spaces and _ . - ! ? # and at most 24 characters: no apostrophes, quotes, colons, commas or brackets, and at most 8 characters besides {name} (tests/i18n-lobby-name.test.mjs).
  'custom.defaultName': 'Lobby {name}',
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
  // Lobby summary line, e.g. 'Pairs 2v2 · P2P · 5 min · Public'. {lock} is ' · 🔒' when the lobby has a password, else empty.
  'custom.info': '{playlist} {mode} · {net} · {length} · {visibility}{lock}',
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

  // Profile and account forms (src/ui/screens/profile.ts)
  // Screen title (window / back stack)
  'profile.title': 'Profile',
  'profile.heading': 'PROFILE',
  // A server error and the wait before retrying, in whole seconds (rounded up)
  'profile.retryAfter': '{message} ({seconds} s)',
  'profile.codesTitle': 'Recovery codes',
  'profile.codesNote': "Each code works once to reset your password if you forget it. There's no email recovery: keep them somewhere safe.",
  'profile.copy': 'COPY',
  'profile.codesCopied': 'Codes copied',
  'profile.copyFailed': "Couldn't copy",
  'profile.codesSaved': "I'VE SAVED THEM",
  'profile.tabSignIn': 'SIGN IN',
  'profile.tabRegister': 'CREATE ACCOUNT',
  'profile.tabRecover': 'RECOVER',
  // Separator above the Google / Discord buttons
  'profile.or': 'or',
  // provider: Google or Discord
  'profile.signInWith': 'Sign in with {provider}',
  'profile.username': 'Username',
  'profile.password': 'Password',
  'profile.signIn': 'SIGN IN',
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
  'profile.playAsGuest': 'PLAY AS A GUEST',
  'profile.guestNote': 'Casual, custom lobbies and training need no account. Competitive and the leaderboard do.',
  'profile.guestName': 'Guest name',
  'profile.saveName': 'SAVE NAME',
  'profile.guestNameSaved': 'Guest name saved',
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
  'profile.rename': 'CHANGE NAME',
  'profile.changePassword': 'CHANGE PASSWORD',
  // For an account that signs in only with Google / Discord
  'profile.setPassword': 'SET PASSWORD',
  'profile.newCodes': 'NEW RECOVERY CODES',
  // provider: GOOGLE or DISCORD (upper case)
  'profile.link': 'LINK {provider}',
  'profile.signOut': 'SIGN OUT',
  'profile.signedOut': 'Signed out',
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

  // Username and password problems by issue code (src/net/account.ts codes, shown by src/ui/screens/profile.ts)
  'account.issue.usernameMissing': 'Choose a username',
  // USERNAME_MIN / USERNAME_MAX (3, 16)
  'account.issue.usernameLength': 'The username must be {min} to {max} characters long',
  'account.issue.usernameChars': 'Use only letters, numbers, "_", "-" or "." (starting with a letter or number)',
  'account.issue.usernameReserved': 'That name is reserved',
  // PASSWORD_MIN (8)
  'account.issue.passwordShort': { one: 'The password must be at least {count} character', other: 'The password must be at least {count} characters' },
  // PASSWORD_MAX (128)
  'account.issue.passwordLong': { one: 'The password can be at most {count} character', other: 'The password can be at most {count} characters' },
  'account.issue.passwordCommon': 'That password is too common',
  'account.issue.passwordHasUsername': "The password can't contain your username",
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
  // Account request could not reach the server (fetch threw)
  'auth.network': 'No connection to the server',
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
  // Lobby request could not reach the server (fetch threw). Same text as auth.network
  'net.lobby.network': 'No connection to the server',

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
  // Column header: win rate
  'board.colWinRate': 'Win %',
  // Win-rate cell; {percent} is a whole number
  'board.winRate': '{percent}%',
  'board.empty': 'Nobody has finished placement in this playlist yet.',
  'board.playPlacement': 'Play 5 placement matches to show up here.',
  'board.signIn': 'Sign in to see your position.',
  // Footer: placed players in this playlist and the season number
  'board.total': { one: '{count} ranked player · Season {season}', other: '{count} ranked players · Season {season}' },
  // No tier yet (placement matches not finished)
  'board.unranked': 'Unranked',
  'board.resultPending': 'Your Competitive result is still being calculated: check your profile.',
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

  // Training screen and packs (src/ui/screens/training.ts, src/game/trainingPacks.ts)
  // Screen title (top bar / history)
  'training.screenTitle': 'Training',
  // Screen heading, uppercase
  'training.title': 'TRAINING',
  // Keep the key names (Backspace, D-pad, arrows) as they are
  'training.subtitle': 'The shot starts when you touch a control. Backspace / D-pad ↓ resets the shot, ← → switch shots.',
  // Subtitle of the Free play tile
  'training.freePlayText': 'You, the ball and unlimited boost',
  // Under the Shooting category
  'training.shootingText': 'Shoot at the rival goal',
  // Under the Saving category
  'training.savingText': 'Stop the shots at your goal',
  // Under the Aerials category
  'training.aerialText': 'High balls: jump and fly',
  // Pack button: shot count and the seconds per shot
  'training.packShots': { one: '{count} shot · {seconds} s', other: '{count} shots · {seconds} s' },
  // Best run: shots passed / shots in the pack
  'training.best': 'Best: {best}/{total}',
  'training.notPlayed': 'Not played',
  // Mode name; the menu tile shows it uppercased
  'training.freePlay': 'Free play',
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
} satisfies Messages;
