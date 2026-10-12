/**
 * Public configuration types for emberdeck.
 *
 * A project describes its Firebase stages and the item types it manages in an
 * `emberdeck.config.{ts,mjs,js,json}` file at the project root.
 */

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** A service account key file on disk (path relative to the config file). */
export interface ServiceAccountFileCredentials {
  type: "serviceAccount";
  file: string;
}

/** A service account key passed as JSON in an environment variable (CI friendly). */
export interface ServiceAccountEnvCredentials {
  type: "serviceAccount";
  env: string;
}

/**
 * Application Default Credentials, e.g. after
 * `gcloud auth application-default login`. Optionally impersonates a service
 * account, which is the recommended setup for teams.
 */
export interface AdcCredentials {
  type: "adc";
  impersonate?: string;
}

export type CredentialsConfig =
  | ServiceAccountFileCredentials
  | ServiceAccountEnvCredentials
  | AdcCredentials;

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

export interface StageConfig {
  /** Firebase / Google Cloud project id. */
  projectId: string;
  /** Default Storage bucket, e.g. `my-app.appspot.com` or `my-app.firebasestorage.app`. */
  bucket?: string;
  credentials: CredentialsConfig;
  /** Shown in the dashboard; protected stages ask for confirmation before writes. */
  protected?: boolean;
  /** Optional accent color for the stage badge in the dashboard. */
  color?: string;
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

interface FieldBase {
  label?: string;
  description?: string;
  required?: boolean;
}

export interface StringField extends FieldBase {
  type: "string";
  default?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** Restrict to a set of values (rendered as a select). */
  enum?: string[];
  multiline?: boolean;
}

export interface NumberField extends FieldBase {
  type: "number";
  default?: number;
  min?: number;
  max?: number;
  integer?: boolean;
}

export interface BooleanField extends FieldBase {
  type: "boolean";
  default?: boolean;
}

export interface DateField extends FieldBase {
  type: "date";
  /** ISO 8601 string. */
  default?: string;
}

export interface JsonField extends FieldBase {
  type: "json";
  default?: unknown;
}

export interface ObjectField extends FieldBase {
  type: "object";
  fields: Record<string, FieldDef>;
}

export interface ListField extends FieldBase {
  type: "list";
  of: FieldDef;
  minItems?: number;
  maxItems?: number;
}

/**
 * A file in Firebase Storage. The item stores the object path; the dashboard
 * handles uploads. `path` may contain `{id}` which is replaced with the item id.
 */
export interface StorageFileField extends FieldBase {
  type: "storageFile";
  path: string;
  /** MIME filter, e.g. `image/*`. */
  accept?: string;
  maxSizeMb?: number;
}

export type FieldDef =
  | StringField
  | NumberField
  | BooleanField
  | DateField
  | JsonField
  | ObjectField
  | ListField
  | StorageFileField;

// ---------------------------------------------------------------------------
// Item types
// ---------------------------------------------------------------------------

export interface RemoteConfigTarget {
  /**
   * Parameter key. Use `{id}` for collections (`banner_{id}` → many items).
   * Without `{id}` the item type is a singleton (exactly one parameter).
   */
  key: string;
  /** Optional Remote Config parameter group. */
  group?: string;
}

export interface ItemTypeConfig {
  label?: string;
  description?: string;
  target: {
    remoteConfig: RemoteConfigTarget;
  };
  fields: Record<string, FieldDef>;
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export interface EmberdeckConfig {
  $schema?: string;
  stages: Record<string, StageConfig>;
  items?: Record<string, ItemTypeConfig>;
}

/** Identity helper that gives you autocompletion in `emberdeck.config.ts`. */
export function defineConfig<const T extends EmberdeckConfig>(config: T): T {
  return config;
}
