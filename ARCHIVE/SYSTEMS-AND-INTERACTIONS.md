# Systems and interaction map

The source and tests are authoritative. This map records functional boundaries and cross-system coupling visible in the pinned V9 implementation.

## Runtime composition

- `source/index.html` is the page entry point. It loads the shared instrument catalog, rolling cards and V9 runtime.
- `source/modules/v9-runtime.js` composes shared lifecycle, page lifecycle, instrument/session orchestration, K-line controller/view, rotation pause, logo and timeframe modules.
- `source/modules/shared/` contains configuration, instrument catalog, lifecycle, page lifecycle and instrument-universe contracts.

## Seven functional systems

1. **Logo** — `source/modules/logo/` owns logo markup, styles and behavior; assets live under `source/assets/logos/`.
2. **Background/full-screen** — `source/background/` and `source/assets/css/full-screen-dynamic.css` define background and full-screen presentation.
3. **Market cards** — `source/cards/` implements rolling cards and styling.
4. **K-line** — `source/kline/gate-kline-controller.js` manages exchange data, cache, refresh and historical repair; `source/kline/v9-kline-view.js` renders charts and chart interactions.
5. **EMA** — `source/kline/ema-engine.js` and `source/kline/v9-vegas-ema.js` implement EMA calculation/overlay behavior.
6. **Timeframe** — `source/modules/timeframe-switch/` provides period selection and its UI contract.
7. **Viewport** — `source/kline/v9-viewport-state.js` defines viewport normalization, persistence/migration and resolution, consumed by the K-line view.

## Cross-system contracts

- Runtime composition and startup/teardown are coordinated by `modules/v9-runtime.js` and shared lifecycle scopes.
- Instrument identity/universe is centralized in the shared catalog rather than duplicated across display modules.
- Timeframe selection flows into runtime/K-line data selection; persisted selection is restored through the runtime contract.
- The K-line view owns rendering and gesture interaction; viewport state is serialized/restored through the dedicated viewport-state module.
- EMA is drawn as an overlay aligned to the K-line chart coordinate space, not as an independent chart viewport.
- Market cards and K-line share instrument identity and runtime orchestration while retaining separate presentation modules.
- Page lifecycle and rotation-pause behavior coordinate visibility, suspension and resumption.

## Interaction coverage

The source tests cover chart-controller behavior, system contracts, viewport state and lifecycle boundaries. Exact selectors, event names, storage keys and gesture thresholds remain defined in source modules and tests; preserve those implementation contracts when changing a subsystem.

## Coupling warning

K-line, EMA, timeframe and viewport are tightly coupled. Logo, cards and background are presentation subsystems coordinated by runtime/page lifecycle. Treat the seven labels as functional groupings of one integrated application, not seven independent packages.
