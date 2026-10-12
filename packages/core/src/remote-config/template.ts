/**
 * Types and pure helpers for the Firebase Remote Config REST template
 * (https://firebase.google.com/docs/reference/remote-config/rest/v1/RemoteConfig).
 */

export type ParameterValueType = "STRING" | "BOOLEAN" | "NUMBER" | "JSON" | "PARAMETER_VALUE_TYPE_UNSPECIFIED";

export type RemoteConfigParameterValue =
  | { value: string }
  | { useInAppDefault: true }
  | { personalizationValue: unknown }
  | { rolloutValue: unknown };

export interface RemoteConfigParameter {
  defaultValue?: RemoteConfigParameterValue;
  conditionalValues?: Record<string, RemoteConfigParameterValue>;
  description?: string;
  valueType?: ParameterValueType;
}

export interface RemoteConfigParameterGroup {
  description?: string;
  parameters: Record<string, RemoteConfigParameter>;
}

export interface RemoteConfigCondition {
  name: string;
  expression: string;
  tagColor?: string;
}

export interface RemoteConfigVersion {
  versionNumber?: string;
  updateTime?: string;
  updateUser?: { email?: string; name?: string };
  description?: string;
  updateOrigin?: string;
  updateType?: string;
  rollbackSource?: string;
}

export interface RemoteConfigTemplate {
  conditions?: RemoteConfigCondition[];
  parameters?: Record<string, RemoteConfigParameter>;
  parameterGroups?: Record<string, RemoteConfigParameterGroup>;
  version?: RemoteConfigVersion;
}

export interface LocatedParameter {
  key: string;
  parameter: RemoteConfigParameter;
  group?: string;
}

/** All parameters, including those inside parameter groups. */
export function listParameters(template: RemoteConfigTemplate): LocatedParameter[] {
  const out: LocatedParameter[] = [];
  for (const [key, parameter] of Object.entries(template.parameters ?? {})) {
    out.push({ key, parameter });
  }
  for (const [group, g] of Object.entries(template.parameterGroups ?? {})) {
    for (const [key, parameter] of Object.entries(g.parameters ?? {})) {
      out.push({ key, parameter, group });
    }
  }
  return out;
}

export function findParameter(template: RemoteConfigTemplate, key: string): LocatedParameter | undefined {
  return listParameters(template).find((p) => p.key === key);
}

/** Returns a copy of the template without the given parameter (wherever it lives). */
export function removeParameter(template: RemoteConfigTemplate, key: string): RemoteConfigTemplate {
  const next = structuredClone(template);
  if (next.parameters) delete next.parameters[key];
  for (const [name, group] of Object.entries(next.parameterGroups ?? {})) {
    delete group.parameters[key];
    // Firebase rejects empty groups only on some setups; keep tidy anyway.
    if (Object.keys(group.parameters).length === 0 && !group.description) {
      delete next.parameterGroups![name];
    }
  }
  return next;
}

/**
 * Inserts or replaces a parameter. If `group` is set the parameter is moved
 * into that group, otherwise it lives at the top level.
 */
export function upsertParameter(
  template: RemoteConfigTemplate,
  key: string,
  parameter: RemoteConfigParameter,
  group?: string,
): RemoteConfigTemplate {
  const next = removeParameter(template, key);
  if (group) {
    next.parameterGroups ??= {};
    next.parameterGroups[group] ??= { parameters: {} };
    next.parameterGroups[group].parameters[key] = parameter;
  } else {
    next.parameters ??= {};
    next.parameters[key] = parameter;
  }
  return next;
}

/** Strips server managed fields before publishing. */
export function toPublishable(template: RemoteConfigTemplate): RemoteConfigTemplate {
  const { version, ...rest } = template;
  return {
    ...rest,
    ...(version?.description ? { version: { description: version.description } } : {}),
  };
}

export function conditionNames(template: RemoteConfigTemplate): Set<string> {
  return new Set((template.conditions ?? []).map((c) => c.name));
}
