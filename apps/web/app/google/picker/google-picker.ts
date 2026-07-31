/**
 * The Google Picker, behind a typed interface.
 *
 * Google ships no type package for `google.picker`, so SOMETHING has to sit at
 * the boundary between an untyped runtime global and our code. This module is
 * that boundary, and it is deliberately the only place that touches `window`:
 * the page above it consumes {@link openGooglePicker} and never sees the global.
 *
 * The alternative — poking at `Record<string, any>` inline in the component —
 * failed the `apps/web` ESLint config (`no-explicit-any` is an ERROR there, not
 * a warning) and broke the Vercel build, since `next build` runs lint. The
 * `packages/` oxlint run does not cover `apps/`, so it passed locally.
 *
 * Everything crossing back OUT of the widget is narrowed, because a shape
 * assumption about a global we do not control is exactly the thing that fails
 * silently in production.
 */

/** The subset of the Picker builder we use. Named to mirror Google's own API. */
interface PickerView {
  setIncludeFolders: (v: boolean) => PickerView;
  setSelectFolderEnabled: (v: boolean) => PickerView;
}

interface PickerInstance {
  setVisible: (visible: boolean) => void;
}

interface PickerBuilder {
  enableFeature: (feature: unknown) => PickerBuilder;
  setAppId: (appId: string) => PickerBuilder;
  setOAuthToken: (token: string) => PickerBuilder;
  setDeveloperKey: (key: string) => PickerBuilder;
  addView: (view: PickerView) => PickerBuilder;
  setCallback: (cb: (data: Record<string, unknown>) => void) => PickerBuilder;
  build: () => PickerInstance;
}

/**
 * Google's `google.picker` namespace, as we use it.
 *
 * The constructors are typed as constructor SIGNATURES rather than `any`, which
 * is what lets the call sites below stay checked. `Feature`/`ViewId`/`Response`/
 * `Action` are opaque enum bags — their values are Google's to define and we
 * only ever pass them straight back.
 */
interface PickerNamespace {
  DocsView: new (viewId: unknown) => PickerView;
  PickerBuilder: new () => PickerBuilder;
  ViewId: Record<string, unknown>;
  Feature: Record<string, unknown>;
  Response: Record<string, string>;
  Action: Record<string, unknown>;
}

/** `gapi`, as we use it: a module loader. */
interface Gapi {
  load: (name: string, cb: () => void) => void;
}

/** A file the user selected. */
export interface PickedFile {
  readonly id: string;
  readonly name: string;
}

export interface OpenPickerArgs {
  readonly accessToken: string;
  readonly developerKey: string;
  readonly appId: string;
  readonly onPicked: (files: readonly PickedFile[]) => void;
  /** Called when the global is missing or the widget cannot be constructed. */
  readonly onUnavailable: () => void;
}

/** Google's loader is injected rather than bundled — it must come from their origin. */
export const GSI_SRC = "https://apis.google.com/js/api.js";

/** Inject Google's loader once; resolves when it is ready. */
export const loadPickerScript = (src: string = GSI_SRC): Promise<void> =>
  new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.append(el);
  });

/**
 * Read `window.gapi`, or null.
 *
 * Structural checks rather than a cast: the loader may not have run, may have
 * been blocked by an extension, or may have loaded a shape we do not expect —
 * all of which should degrade to "unavailable", not to a TypeError mid-render.
 */
const readGapi = (): Gapi | null => {
  const gapi = Reflect.get(globalThis, "gapi");
  if (typeof gapi !== "object" || gapi === null) return null;
  const load = Reflect.get(gapi, "load");
  return typeof load === "function" ? { load: load.bind(gapi) } : null;
};

/** Read `window.google.picker`, or null, verifying the members we actually call. */
const readPicker = (): PickerNamespace | null => {
  const google = Reflect.get(globalThis, "google");
  if (typeof google !== "object" || google === null) return null;
  const picker = Reflect.get(google, "picker");
  if (typeof picker !== "object" || picker === null) return null;
  for (const key of ["DocsView", "PickerBuilder"]) {
    if (typeof Reflect.get(picker, key) !== "function") return null;
  }
  // Verified structurally above; this is the single narrowing point for the
  // whole module, which is the reason the boundary exists.
  return picker as unknown as PickerNamespace;
};

/** Narrow the widget's callback payload into our own shape. */
export const readPickedFiles = (docs: unknown): PickedFile[] =>
  Array.isArray(docs)
    ? docs.flatMap((d: unknown) => {
        if (d === null || typeof d !== "object") return [];
        const id = Reflect.get(d, "id");
        const name = Reflect.get(d, "name");
        if (typeof id !== "string" || id === "") return [];
        return [{ id, name: typeof name === "string" ? name : id }];
      })
    : [];

/**
 * Open the Picker, restricted to spreadsheets.
 *
 * `onPicked` fires only on a genuine PICKED action with at least one usable
 * file — cancel and close are silent, because the caller has nothing to do in
 * either case and a spurious callback would look like an empty selection.
 */
export const openGooglePicker = (args: OpenPickerArgs): void => {
  const gapi = readGapi();
  if (gapi === null) {
    args.onUnavailable();
    return;
  }

  gapi.load("picker", () => {
    const picker = readPicker();
    if (picker === null) {
      args.onUnavailable();
      return;
    }

    const view = new picker.DocsView(picker.ViewId.SPREADSHEETS)
      // Shared drives matter for real teams; without this a user simply cannot
      // see the sheet they were told to connect.
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false);

    new picker.PickerBuilder()
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .setAppId(args.appId)
      .setOAuthToken(args.accessToken)
      .setDeveloperKey(args.developerKey)
      .addView(view)
      .setCallback((data: Record<string, unknown>) => {
        if (data[picker.Response.ACTION] !== picker.Action.PICKED) return;
        const files = readPickedFiles(data[picker.Response.DOCUMENTS]);
        if (files.length > 0) args.onPicked(files);
      })
      .build()
      .setVisible(true);
  });
};
