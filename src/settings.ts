import { create } from 'zustand';
import { bridge } from './bridge';
import { SettingsPersistence } from './settingsPersistence';
import {
  DEFAULT_AI,
  DEFAULT_SETTINGS,
  makeProfile,
  parseSettings,
  sanitizeSettings,
} from './config';
import type { AppSettings } from './config';
import type { AiConfig, AiProfile } from './ai/types';
import type { CoachConfig, CoachOptionKey } from './coach/types';
import type { Actor } from './game/types';

interface SettingsStore {
  settings: AppSettings;
  loaded: boolean;
  /** Set when the saved file could not be read; the app still starts on defaults. */
  loadError: string | null;
  loadSettings(): Promise<void>;
  update(patch: Partial<AppSettings>): void;
  /** Patch the profile currently open in the settings editor. */
  updateAi(patch: Partial<AiConfig>): void;
  updateUi(patch: Partial<AppSettings['ui']>): void;
  /** Coach mode of the next game; chosen in the new-game dialog. */
  updateCoach(patch: Partial<CoachConfig>): void;
  updateCoachOption(key: CoachOptionKey, value: boolean): void;
  replace(next: AppSettings): void;
  /** Currently selected (edited / played) profile id. */
  selectProfile(id: string): void;
  addProfile(name?: string): string;
  duplicateProfile(id: string): string | null;
  renameProfile(id: string, name: string): void;
  removeProfile(id: string): void;
  /** Choose which profile a side uses for the next game. */
  setSideProfile(side: 'w' | 'b', id: string): void;
}

let loading: Promise<void> | null = null;

/** Called when a background save fails, so the UI can tell the user. */
let saveErrorHandler: ((message: string) => void) | null = null;

export function onSettingsSaveError(handler: ((message: string) => void) | null): void {
  saveErrorHandler = handler;
}

const persistence = new SettingsPersistence(
  (json) => bridge.saveSettings(json),
  (error) => saveErrorHandler?.(`设置保存失败：${error instanceof Error ? error.message : String(error)}`),
);

/** Write a pending debounced save immediately (used when the window closes). */
export async function flushSettingsSave(): Promise<void> {
  await persistence.flush();
}

/** Read the effective config for one side. */
export function profileFor(settings: AppSettings, side: 'w' | 'b'): AiProfile {
  const id = settings.aiSelection[side];
  return settings.aiProfiles.find((profile) => profile.id === id) ?? settings.aiProfiles[0];
}

/** Read the profile currently open in the settings editor. */
export function activeProfileOf(settings: AppSettings): AiProfile {
  return (
    settings.aiProfiles.find((profile) => profile.id === settings.activeProfile) ??
    settings.aiProfiles[0]
  );
}

/**
 * The profile that answers coach requests for a game.
 *
 * An explicit pick wins. Otherwise the coach follows the engine that plays
 * against the human, so "more of the same model" is the default; when neither
 * side is an engine (both human, or both AI) there is nothing to follow and the
 * profile open in the editor is used.
 */
export function coachProfileFor(
  settings: AppSettings,
  players: { w: Actor; b: Actor },
): AiProfile {
  const picked = settings.aiProfiles.find((profile) => profile.id === settings.coach.profileId);
  if (picked) return picked;
  if (players.w === 'human' && players.b === 'ai') return profileFor(settings, 'b');
  if (players.b === 'human' && players.w === 'ai') return profileFor(settings, 'w');
  return activeProfileOf(settings);
}

export const useSettings = create<SettingsStore>((set, get) => {
  /**
   * Apply a change and persist it.
   *
   * Before the initial load finishes the in-memory settings are still the
   * built-in defaults; persisting them would overwrite the user's real
   * profiles and API keys on disk. The app also gates its UI on `loaded`, but
   * this guard makes the invariant local to the store.
   */
  function commit(next: AppSettings): void {
    set({ settings: next });
    if (!get().loaded || get().loadError) return;
    persistence.schedule(JSON.stringify(next));
  }

  function withProfiles(settings: AppSettings, profiles: AiProfile[]): AppSettings {
    const byId = new Set(profiles.map((profile) => profile.id));
    const first = profiles[0].id;
    return {
      ...settings,
      aiProfiles: profiles,
      activeProfile: byId.has(settings.activeProfile) ? settings.activeProfile : first,
      aiSelection: {
        w: byId.has(settings.aiSelection.w) ? settings.aiSelection.w : first,
        b: byId.has(settings.aiSelection.b) ? settings.aiSelection.b : first,
      },
      // Deleting a profile must not leave the coach pointing at it.
      coach:
        settings.coach.profileId && !byId.has(settings.coach.profileId)
          ? { ...settings.coach, profileId: '' }
          : settings.coach,
    };
  }

  return {
    settings: sanitizeSettings(DEFAULT_SETTINGS),
    loaded: false,
    loadError: null,

    async loadSettings() {
      if (loading) return loading;
      loading = (async () => {
        try {
          const raw = await bridge.loadSettings();
          set({ settings: parseSettings(raw), loaded: true, loadError: null });
        } catch (error) {
          // Keep the original file safe until a successful read resolves this.
          const message = error instanceof Error ? error.message : String(error);
          set({ settings: sanitizeSettings(DEFAULT_SETTINGS), loaded: true, loadError: message });
        }
      })();
      try { await loading; } finally { loading = null; }
    },

    update(patch) {
      commit({ ...get().settings, ...patch });
    },

    updateAi(patch) {
      const settings = get().settings;
      const active = activeProfileOf(settings);
      commit({
        ...settings,
        aiProfiles: settings.aiProfiles.map((profile) =>
          profile.id === active.id ? { ...profile, config: { ...profile.config, ...patch } } : profile,
        ),
      });
    },

    updateUi(patch) {
      const settings = get().settings;
      commit({ ...settings, ui: { ...settings.ui, ...patch } });
    },

    updateCoach(patch) {
      const settings = get().settings;
      commit({ ...settings, coach: { ...settings.coach, ...patch } });
    },

    updateCoachOption(key, value) {
      const settings = get().settings;
      commit({ ...settings, coach: { ...settings.coach, [key]: value } });
    },

    replace(next) {
      commit(sanitizeSettings(next));
    },

    selectProfile(id) {
      const settings = get().settings;
      if (!settings.aiProfiles.some((profile) => profile.id === id)) return;
      commit({ ...settings, activeProfile: id });
    },

    addProfile(name) {
      const settings = get().settings;
      // Seed a new profile from the one being edited, which is almost always
      // "the same gateway, another model" rather than a blank form.
      const seed = { ...activeProfileOf(settings).config };
      const profile = makeProfile(
        name?.trim() || `配置 ${settings.aiProfiles.length + 1}`,
        seed,
      );
      commit(withProfiles({ ...settings, activeProfile: profile.id }, [...settings.aiProfiles, profile]));
      return profile.id;
    },

    duplicateProfile(id) {
      const settings = get().settings;
      const source = settings.aiProfiles.find((profile) => profile.id === id);
      if (!source) return null;
      const copy = makeProfile(`${source.name} 副本`, source.config);
      commit(withProfiles({ ...settings, activeProfile: copy.id }, [...settings.aiProfiles, copy]));
      return copy.id;
    },

    renameProfile(id, name) {
      const settings = get().settings;
      const trimmed = name.trim();
      if (!trimmed) return;
      commit({
        ...settings,
        aiProfiles: settings.aiProfiles.map((profile) =>
          profile.id === id ? { ...profile, name: trimmed } : profile,
        ),
      });
    },

    removeProfile(id) {
      const settings = get().settings;
      // Never leave the app without a profile: there must always be one to play.
      if (settings.aiProfiles.length <= 1) return;
      const profiles = settings.aiProfiles.filter((profile) => profile.id !== id);
      commit(withProfiles(settings, profiles));
    },

    setSideProfile(side, id) {
      const settings = get().settings;
      if (!settings.aiProfiles.some((profile) => profile.id === id)) return;
      commit({ ...settings, aiSelection: { ...settings.aiSelection, [side]: id } });
    },
  };
});

export { DEFAULT_AI };
