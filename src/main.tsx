import { caseOpenAction } from './application/case-open-action.ts';
import { parentRoute } from './application/navigation-map.ts';
import { gameAudio } from './adapters/outbound/browser/game-audio.ts';
import { ConsoleErrorReporter } from './adapters/outbound/browser/console-error-reporter.ts';
import { Failsafe } from './adapters/inbound/browser/failsafe.ts';
import { loadWreck, saveWreck } from './adapters/outbound/browser/wreck-snapshots.ts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './adapters/inbound/react/App.tsx';
import { LoginScreen } from './adapters/inbound/react/LoginScreen.tsx';
import { ErrorNotice } from './adapters/inbound/react/ErrorNotice.tsx';
import { Button } from './adapters/inbound/react/Button.tsx';
import { ApiAuthGateway } from './adapters/outbound/data/api-auth-gateway.ts';
import type { Player } from './application/ports/auth-gateway.ts';
import { InventoryScreen } from './adapters/inbound/react/InventoryScreen.tsx';
import { ApiInventory } from './adapters/outbound/data/api-inventory.ts';
import { ApiItems } from './adapters/outbound/data/api-items.ts';
import { ApiWallet } from './adapters/outbound/data/api-wallet.ts';
import { WalletScreen } from './adapters/inbound/react/WalletScreen.tsx';
import { ItemsScreen } from './adapters/inbound/react/ItemsScreen.tsx';
import { AccountContext, type Account } from './adapters/inbound/react/AccountContext.tsx';
import { ChestPreviewRenderer } from './adapters/outbound/chest/chest-preview-renderer.ts';
import { ThreeItemPresentation } from './adapters/outbound/items/three-item-presentation.ts';
import { ItemPresentationContext } from './adapters/inbound/react/ItemArt.tsx';
import { NO_BREAKAGE } from './domain/chest-breakage.ts';
import { destroyedBreakage } from './adapters/outbound/chest/destroyed-breakage.ts';
import type { OutcomeGateway } from './application/ports/outcome-gateway.ts';
import { isConsumed, nextOwnedCase, type CaseInstance } from './domain/case-instance.ts';
import { CaseDirectory } from './adapters/inbound/react/CaseDirectory.tsx';
import { CasePresentationContext } from './adapters/inbound/react/case-presentation.ts';
import { NavigationContext } from './adapters/inbound/react/NavigationContext.tsx';
import { SoundControl } from './adapters/inbound/react/SoundControl.tsx';
import { GlobalSearch } from './adapters/inbound/react/GlobalSearch.tsx';
import { createApplication } from './composition/create-application.ts';
import { CASES, type CaseDefinition } from './config/cases.ts';
import { ThreeChestDropScene } from './adapters/outbound/chest/three-chest-drop-scene.ts';
import { CanvasRoulette } from './adapters/outbound/browser/canvas-roulette.ts';
import { InventoryRecentFind } from './application/inventory-recent-find.ts';
import { SoundSettings } from './adapters/outbound/browser/sound-settings.ts';
import { ClickSound } from './adapters/outbound/browser/click-sound.ts';
import { ScreenStorage } from './adapters/outbound/browser/screen-storage.ts';
import { BrowserRouter } from './adapters/outbound/browser/browser-router.ts';
import { MemorySessionJournal } from './adapters/outbound/browser/memory-session-journal.ts';
import { GameTransitions } from './adapters/outbound/browser/game-transitions.ts';
import { browserFrameEnvironment } from './adapters/outbound/browser/frame-scheduler.ts';
import { normalizeBaseUrl, resolvePublicAsset } from './adapters/outbound/data/asset-url.ts';
import { browserFetch } from './adapters/outbound/data/request-json.ts';
import { sessionFetch } from './adapters/outbound/data/session-fetch.ts';
import './adapters/inbound/react/styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Application root was not found.');
const root = createRoot(container);
const design = new URL(window.location.href).searchParams.get('design');
const theme = design === 'gallery' || design === 'minimal' ? design : 'ender';
document.documentElement.dataset.homeDesign = theme;
const baseUrl = normalizeBaseUrl(new URL(import.meta.env.BASE_URL, document.baseURI));
const storage = new ScreenStorage(() => window.localStorage);
const navigation = new BrowserRouter(window, storage);
// Nobody is left hanging: unexpected errors, stuck phases and render loops end in a modal with a
// way back to the main screen, and are reported (console now, Sentry later).
const reporter = new ConsoleErrorReporter();
const failsafe = new Failsafe({
  document,
  reporter,
  goHome: () => navigation.go({ screen: 'inventory' }, true),
  isHome: () => navigation.getState().screen === 'inventory',
});
failsafe.install();
// The player's chests live on the server only: it issues them and owns their state.
// A 401 from the player's own data: refresh the session first; if the gateway refuses, the browser's
// saved state goes, and only then the player goes out to the sign-in, nothing kept.
const authenticatedFetch = sessionFetch(
  browserFetch,
  resolvePublicAsset('api/v1/auth/refresh', baseUrl),
  () => {
    clearSavedState();
    expireSession();
  },
);
const inventory = new ApiInventory(
  baseUrl,
  CASES,
  (error) => reporter.capture(error, { code: 'INVENTORY_SYNC_FAILED' }),
  authenticatedFetch,
);
// Inventory and Wallet use independent gateways and state.
const items = new ApiItems(
  baseUrl,
  (error) => reporter.capture(error, { code: 'ITEMS_SYNC_FAILED' }),
  authenticatedFetch,
);
const wallet = new ApiWallet(baseUrl, authenticatedFetch);
// Chests were once kept in the browser (a demo store); nothing of that is used any more.
try {
  const stale = /^voxel-vault:(demo-inventory-v2|demo-stock:|last-find:|session:)/;
  for (const key of Object.keys(window.localStorage))
    if (stale.test(key)) window.localStorage.removeItem(key);
  for (const key of Object.keys(window.sessionStorage))
    if (key.startsWith('wreck:')) window.sessionStorage.removeItem(key);
} catch {
  /* No browser storage: nothing to clean. */
}
/** Opening checkpoints by case runtime, for this page only (rebuilding a runtime keeps its place). */
const journals = new Map<string, MemorySessionJournal>();
const sessionJournals = (identity: string) => {
  let journal = journals.get(identity);
  if (!journal) journals.set(identity, (journal = new MemorySessionJournal()));
  return journal;
};
let previews: ChestPreviewRenderer | undefined;
/** Item models for every screen and the roulette strip: one preview context for the page. */
const itemArt = new ThreeItemPresentation(document, baseUrl);
let runtime: ReturnType<typeof createCaseRuntime> | undefined;
let pendingOpenInstanceId: string | undefined;
const soundPreference = new SoundSettings(
  () => window.localStorage,
  (muted) => {
    runtime?.sound.setMuted(muted);
    runtime?.scene.setSoundMuted(muted);
    gameAudio.setMuted(muted);
  },
  () => {
    runtime?.sound.unlock();
    runtime?.scene.unlockAudio();
    gameAudio.unlock();
  },
);
gameAudio.setMuted(soundPreference.isMuted());
// Every action is heard: a tick on any button press (also unlocks audio inside the gesture).
document.addEventListener(
  'click',
  (event) => {
    if (!(event.target instanceof Element) || !event.target.closest('button, a, [role="button"]'))
      return;
    gameAudio.unlock();
    gameAudio.click();
  },
  true,
);

/** Resources belong to the selected case, outside React effects and StrictMode. */
function createCaseRuntime(
  definition: CaseDefinition,
  instance?: CaseInstance,
  returnTo?: 'archive',
) {
  const identity = `${definition.id}:${instance?.id ?? 'browse'}:${returnTo ?? 'normal'}`;
  failsafe.noteRebuild(identity);
  const routeBase = {
    caseId: definition.id,
    ...(instance ? { instanceId: instance.id } : {}),
    ...(returnTo ? { returnTo } : {}),
  };
  const scene = new ThreeChestDropScene(
    baseUrl,
    document,
    definition.model,
    instance?.appearance ?? definition.appearance,
    undefined,
    NO_BREAKAGE,
    Number.parseInt(definition.presentation.theme.accent.slice(1), 16),
  );
  // The server lands and opens the chest; the scene draws what it decided before the chest falls.
  const outcome: OutcomeGateway | undefined = instance
    ? {
        async decide(sessionId, signal) {
          const decided = await inventory.open(instance.id, sessionId, signal);
          scene.setBreakage(
            'destroyed' in decided
              ? destroyedBreakage(instance, definition.model.modifications, decided.destroyed)
              : NO_BREAKAGE,
          );
          return decided;
        },
      }
    : undefined;
  const sound = new ClickSound(resolvePublicAsset('audio/click.wav', baseUrl));
  sound.setMuted(soundPreference.isMuted());
  scene.setSoundMuted(soundPreference.isMuted());
  const roulette = new CanvasRoulette(document, {
    sound,
    cue: (cue) => (cue === 'wind-up' ? gameAudio.spinStart() : gameAudio.spinLock()),
    art: (item, signal) => (itemArt.has(item.id) ? itemArt.preview(item.id, signal) : undefined),
  });
  const effectColor = definition.presentation.theme.accent;
  const transitions = new GameTransitions(
    browserFrameEnvironment(window, document),
    roulette.element,
  );
  transitions.element.style.background = `radial-gradient(ellipse, #ffffff, ${effectColor})`;
  // In memory only: after a reload the server says the chest is being opened in its session, and
  // the opening resumes from there (the server rolls the same prize for the same session).
  const journal = instance ? sessionJournals(identity) : undefined;
  if (instance?.status === 'opening' && !journal!.load())
    journal!.save({ stage: 'chest', sessionId: instance.sessionId! });
  // An owned chest's catalog and roulette are its own contents, not everything its type can hold.
  const application = createApplication({
    baseUrl,
    catalogPath: definition.catalogPath,
    contents: instance?.contents.map((slot) => slot.item),
    journal,
    outcome,
    ownership: instance ? { reveal: () => inventory.reveal(instance.id) } : undefined,
    presentation: { chest: scene, roulette, transitions },
  });
  const recentFind = new InventoryRecentFind(inventory, definition.id);
  let initializing = true;
  const syncRoute = () => {
    if (initializing || runtime?.identity !== identity) return;
    const state = application.session!.getState(),
      route = navigation.getState();
    if (!('caseId' in route) || route.caseId !== definition.id) return;
    if (state.phase === 'prize-visible')
      navigation.go({ screen: 'reward', ...routeBase, sessionId: state.sessionId }, true);
    else if ('sessionId' in state)
      navigation.go(
        { screen: 'opening', ...routeBase, sessionId: state.sessionId },
        route.screen === 'opening' || route.screen === 'reward',
      );
    else if (state.phase === 'ready' && (route.screen === 'opening' || route.screen === 'reward'))
      navigation.go({ screen: 'case', ...routeBase }, true);
  };
  // Outcome stings: the reward by its rarity, or the loss.
  let heard: string | undefined;
  const unsubscribeOutcome = application.session!.subscribe(() => {
    const state = application.session!.getState();
    const key = 'sessionId' in state ? `${state.phase}:${state.sessionId}` : state.phase;
    if (key === heard) return;
    heard = key;
    if (state.phase === 'prize-visible') gameAudio.reward(state.selection.prize.rarity);
    else if (state.phase === 'destroyed') {
      // Take the picture of the wreck once, now, and keep it for this session.
      if (!loadWreck(state.sessionId)) saveWreck(state.sessionId, scene.captureWreck());
      gameAudio.destroyed();
    }
  });
  const unwatch = failsafe.watch(application.session!, {
    caseId: definition.id,
    instanceId: instance?.id ?? null,
  });
  const unsubscribe = () => {
    unwatch();
    unsubscribeOutcome();
    unsubscribeSync();
  };
  const unsubscribeSync = application.session!.subscribe(syncRoute);
  return {
    identity,
    effectColor,
    instanceId: instance?.id,
    definition,
    scene,
    sound,
    roulette,
    transitions,
    application,
    recentFind,
    initialize() {
      void application.initialize().finally(() => {
        initializing = false;
        syncRoute();
        if (instance && pendingOpenInstanceId === instance.id && runtime?.identity === identity) {
          pendingOpenInstanceId = undefined;
          if (application.session!.getState().phase === 'ready')
            void application.session!.openChest();
        }
      });
    },
    dispose() {
      unsubscribe();
      recentFind.dispose();
      try {
        application.dispose();
      } finally {
        sound.dispose();
      }
    },
  };
}

/**
 * Escape = back towards the inventory. Dialogs and text fields keep their own Escape; while a chest
 * is opening it does nothing; on a reward or destruction screen it closes it, landing on the case
 * overview of the same chest.
 */
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) return;
  const target = event.target instanceof Element ? event.target : null;
  if (
    document.querySelector('dialog[open]') ||
    target?.closest('input, textarea, select, [contenteditable="true"]')
  )
    return;
  const phase = runtime?.application.session?.getState().phase;
  if (phase === 'prize-visible' || phase === 'destroyed') {
    event.preventDefault();
    void runtime!.application.session!.closePrize();
    return;
  }
  if (
    phase &&
    [
      'clearing',
      'dropping',
      'opening',
      'flashing',
      'spinning',
      'settling',
      'revealing',
      'resetting',
    ].includes(phase)
  )
    return;
  const parent = parentRoute(navigation.getState());
  if (parent) {
    event.preventDefault();
    navigation.go(parent);
  }
});

/**
 * Nothing is shown before the server knows the player: the session cookie is checked first, and
 * without one the way in is the login screen (passkey or Telegram). A server that cannot be
 * reached is said plainly, with a retry, instead of an app that fails piece by piece.
 */
const auth = new ApiAuthGateway(baseUrl, authenticatedFetch);
let session:
  | { readonly state: 'checking' }
  | { readonly state: 'signed-out' | 'unavailable' }
  | { readonly state: 'signed-in'; readonly player: Player } = { state: 'checking' };
async function checkSession() {
  session = { state: 'checking' };
  renderRoute();
  try {
    const player = await auth.current();
    session = player ? { state: 'signed-in', player } : { state: 'signed-out' };
  } catch (error) {
    reporter.capture(error, { code: 'SESSION_CHECK_FAILED' });
    session = { state: 'unavailable' };
  }
  renderRoute();
}
/** The game's own keys in localStorage (screens, last finds); the sound setting belongs to the device and stays. */
function clearSavedState() {
  try {
    for (const key of Object.keys(window.localStorage))
      if (key.startsWith('voxel-vault:') && key !== 'voxel-vault:sound-muted')
        window.localStorage.removeItem(key);
  } catch {
    /* No browser storage: nothing to clear. */
  }
}
function expireSession() {
  if (session.state !== 'signed-in') return;
  session = { state: 'signed-out' };
  inventoryLoad = undefined;
  account = undefined;
  inventory.clear();
  const previous = runtime;
  runtime = undefined;
  previous?.dispose();
  renderRoute();
}
/** The player's chests are read from the server once signed in, before any screen shows them. */
let inventoryLoad: Promise<void> | undefined;
/** The header's wallet and profile; balances refresh after workshop operations. */
let account: Account | undefined;
function accountOf(player: Player): Account {
  if (account?.player !== player) {
    wallet.reset();
    account = {
      player,
      wallet,
      signOut() {
        void auth
          .signOut()
          .catch((error) => reporter.capture(error, { code: 'SIGN_OUT_FAILED' }))
          .finally(() => window.location.reload());
      },
    };
    void items.load().catch((error) => reporter.capture(error, { code: 'ITEMS_LOAD_FAILED' }));
    void wallet.load().catch((error) => reporter.capture(error, { code: 'WALLET_LOAD_FAILED' }));
  }
  return account;
}
function loadInventory() {
  inventoryLoad ??= inventory
    .load()
    .catch((error) => {
      reporter.capture(error, { code: 'INVENTORY_LOAD_FAILED' });
      inventoryLoad = undefined;
      session = { state: 'unavailable' };
    })
    .finally(renderRoute);
}
function renderGate(): boolean {
  if (session.state === 'signed-in' && inventory.isLoaded()) return false;
  if (session.state === 'signed-in') loadInventory();
  root.render(
    <StrictMode>
      {session.state === 'signed-out' ? (
        <LoginScreen
          auth={auth}
          onSignedIn={(player) => {
            session = { state: 'signed-in', player };
            renderRoute();
          }}
        />
      ) : (
        <main className="page-shell">
          {session.state === 'unavailable' ? (
            <ErrorNotice
              eyebrow="Нет связи с сервером"
              title="Хранилище недоступно"
              actions={
                <Button
                  onClick={() => {
                    void checkSession();
                  }}
                >
                  Повторить
                </Button>
              }
            >
              <p>
                Не удалось связаться с сервером. Проверьте соединение — сундуки и награды хранятся
                на сервере и никуда не денутся.
              </p>
            </ErrorNotice>
          ) : (
            <div className="feedback" role="status" aria-live="polite">
              <span className="loader" aria-hidden="true" />
              <p>Открываем хранилище…</p>
            </div>
          )}
        </main>
      )}
    </StrictMode>,
  );
  return true;
}

const signedIn = () => (session.state === 'signed-in' ? accountOf(session.player) : undefined);
function renderRoute() {
  if (renderGate()) return;
  const route = navigation.getState();
  if (route.screen === 'case' && !route.instanceId) {
    const owned = nextOwnedCase(inventory.getState(), route.caseId);
    if (owned) {
      navigation.go({ ...route, instanceId: owned.id }, true);
      return;
    }
  }
  if (
    pendingOpenInstanceId &&
    (!('instanceId' in route) || route.instanceId !== pendingOpenInstanceId)
  )
    pendingOpenInstanceId = undefined;
  const requestedInstance = 'instanceId' in route ? route.instanceId : undefined;
  const instance = requestedInstance
    ? inventory.getState().find((item) => item.id === requestedInstance)
    : undefined;
  const definition =
    'caseId' in route && (!requestedInstance || instance?.caseId === route.caseId)
      ? CASES.find((item) => item.id === route.caseId)
      : undefined;
  // Must match createCaseRuntime's identity exactly, or every render rebuilds the runtime.
  const returnTo = 'returnTo' in route ? route.returnTo : undefined;
  const identity = definition
    ? `${definition.id}:${instance?.id ?? 'browse'}:${returnTo ?? 'normal'}`
    : undefined;
  if (route.screen !== 'inventory' && route.screen !== 'archive' && route.screen !== 'catalog') {
    previews?.dispose();
    previews = undefined;
  }
  if (runtime && runtime.identity !== identity) {
    const previous = runtime;
    runtime = undefined;
    previous.dispose();
  }
  let fresh = false;
  if (definition && !runtime) {
    runtime = createCaseRuntime(
      definition,
      instance,
      'returnTo' in route ? route.returnTo : undefined,
    );
    fresh = true;
  }
  // Dev-only handle for inspecting the live scene from the browser console.
  if (import.meta.env.DEV)
    (window as unknown as { __caseRuntime?: unknown }).__caseRuntime = runtime;
  if (!definition) {
    if (route.screen === 'inventory' || route.screen === 'archive' || route.screen === 'catalog')
      previews ??= new ChestPreviewRenderer(document, baseUrl);
    root.render(
      <StrictMode>
        <AccountContext.Provider value={signedIn()}>
          <ItemPresentationContext.Provider value={itemArt}>
            {route.screen === 'inventory' || route.screen === 'archive' ? (
              <InventoryScreen
                key={route.screen}
                mode={route.screen}
                inventory={inventory}
                items={items}
                cases={CASES}
                navigation={navigation}
                storage={storage}
                renderer={previews!}
                soundPreference={soundPreference}
              />
            ) : route.screen === 'items' ? (
              <ItemsScreen
                items={items}
                navigation={navigation}
                archiveCount={inventory.getState().filter(isConsumed).length}
                chestCount={
                  inventory.getState().filter((item) => item.status === 'available').length
                }
                soundPreference={soundPreference}
              />
            ) : route.screen === 'wallet' ? (
              <WalletScreen
                wallet={wallet}
                navigation={navigation}
                soundPreference={soundPreference}
              />
            ) : route.screen === 'catalog' ? (
              <CaseDirectory
                instances={inventory.getState()}
                cases={CASES}
                navigation={navigation}
                storage={storage}
                renderer={previews!}
                soundPreference={soundPreference}
              />
            ) : (
              <>
                <SoundControl preference={soundPreference} />
                <main className="page-shell case-directory">
                  <div className="feedback">
                    <h1>Сундук не найден</h1>
                    <p>Возможно, ссылка устарела.</p>
                    <button
                      className="btn btn-transparent"
                      onClick={() => navigation.go({ screen: 'inventory' }, true)}
                    >
                      К сундукам
                    </button>
                  </div>
                </main>
              </>
            )}
            <GlobalSearch
              navigation={navigation}
              cases={CASES}
              inventory={inventory}
              baseUrl={baseUrl}
            />
          </ItemPresentationContext.Provider>
        </AccountContext.Provider>
      </StrictMode>,
    );
    return;
  }
  const current = runtime!;
  const archiveView = 'returnTo' in route && route.returnTo === 'archive';
  const action = archiveView
    ? { action: 'leave' as const, target: undefined, label: 'Вернуться в архив', availableCount: 0 }
    : caseOpenAction(inventory.getState(), definition.id, current.instanceId);
  const state = current.application.session!.getState();
  if (!fresh && route.screen === 'case' && state.phase === 'prize-visible')
    void current.application.session!.closePrize();
  root.render(
    <StrictMode>
      <AccountContext.Provider value={signedIn()}>
        <ItemPresentationContext.Provider value={itemArt}>
          <NavigationContext.Provider value={{ navigation, storage }}>
            <GlobalSearch
              navigation={navigation}
              cases={CASES}
              inventory={inventory}
              baseUrl={baseUrl}
            />
            <CasePresentationContext.Provider value={definition.presentation}>
              <App
                captureWreck={() => {
                  const state = current.application.session!.getState();
                  return 'sessionId' in state ? loadWreck(state.sessionId) : undefined;
                }}
                caseId={definition.id}
                inspectedCase={instance}
                casePalette={definition.presentation.theme}
                availableCaseCount={action.availableCount}
                archiveCount={inventory.getState().filter(isConsumed).length}
                archiveView={archiveView}
                openLabel={action.label}
                onOpenRequest={() => {
                  const { target, action: offer } = caseOpenAction(
                    inventory.getState(),
                    definition.id,
                    current.instanceId,
                  );
                  if (offer === 'leave' || !target) {
                    navigation.go(parentRoute(navigation.getState()) ?? { screen: 'inventory' });
                    return;
                  }
                  if (target.id === current.instanceId) {
                    void current.application.session!.openChest();
                    return;
                  }
                  pendingOpenInstanceId = target.status === 'available' ? target.id : undefined;
                  navigation.go({ screen: 'case', caseId: definition.id, instanceId: target.id });
                  runtime?.sound.unlock();
                  runtime?.scene.unlockAudio();
                }}
                onPrizeClose={() => {
                  void current.application.session!.closePrize();
                }}
                recentFind={current.recentFind}
                soundPreference={soundPreference}
                catalog={current.application.catalog}
                session={current.application.session}
                sceneElement={current.scene.element}
                rouletteElement={current.roulette.element}
                onOpenGesture={() => {
                  current.sound.unlock();
                  current.scene.unlockAudio();
                }}
                transitionElement={current.transitions.element}
                onRetryInitialization={current.application.initialize}
                backgroundUrl={resolvePublicAsset(definition.presentation.backgroundPath, baseUrl)}
                world={{
                  id: definition.presentation.world,
                  chest: current.scene.handles,
                  guest: current.scene.guest,
                }}
              />
            </CasePresentationContext.Provider>
          </NavigationContext.Provider>
        </ItemPresentationContext.Provider>
      </AccountContext.Provider>
    </StrictMode>,
  );
  if (fresh) current.initialize();
}
let lastScreen = navigation.getState().screen;
const unsubscribeRoute = navigation.subscribe(() => {
  const screen = navigation.getState().screen;
  if (screen !== lastScreen && screen !== 'opening' && screen !== 'reward') gameAudio.navigate();
  lastScreen = screen;
  renderRoute();
});
const unsubscribeInventory = inventory.subscribe(renderRoute);
void checkSession();
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    unsubscribeRoute();
    unsubscribeInventory();
    navigation.dispose();
    root.unmount();
    previews?.dispose();
    runtime?.dispose();
  });
