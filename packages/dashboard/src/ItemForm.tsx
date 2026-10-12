import { useEffect, useRef, useState, type ReactNode } from "react";
import type { FieldDef } from "@emberdeck/core";
import { api } from "./api";

/**
 * Renders an editor for an item from its field definitions. Every field type
 * of the config maps to one control; objects and lists recurse.
 */

type Value = Record<string, unknown>;

export interface FieldContext {
  stage: string;
  itemId: string;
  /** Issues keyed by dotted path, from server-side validation. */
  issues: Record<string, string>;
}

export function ItemForm(props: {
  fields: Record<string, FieldDef>;
  value: Value;
  onChange(value: Value): void;
  ctx: FieldContext;
}) {
  return (
    <div className="form">
      <ObjectFields {...props} path="" />
    </div>
  );
}

function ObjectFields(props: {
  fields: Record<string, FieldDef>;
  value: Value;
  onChange(value: Value): void;
  ctx: FieldContext;
  path: string;
}) {
  const { fields, value, onChange, ctx, path } = props;
  return (
    <>
      {Object.entries(fields).map(([name, def]) => {
        const childPath = path ? `${path}.${name}` : name;
        return (
          <Field
            key={name}
            name={name}
            def={def}
            value={value[name]}
            path={childPath}
            ctx={ctx}
            onChange={(v) => {
              const next = { ...value };
              if (v === undefined) delete next[name];
              else next[name] = v;
              onChange(next);
            }}
          />
        );
      })}
    </>
  );
}

function Field(props: {
  name: string;
  def: FieldDef;
  value: unknown;
  path: string;
  ctx: FieldContext;
  onChange(value: unknown): void;
}) {
  const { name, def, value, path, ctx, onChange } = props;
  const label = def.label ?? name;
  const issue = ctx.issues[path];
  const id = `f-${path}`;

  const wrap = (control: ReactNode, inline = false) => (
    <div className={`field${inline ? " field--inline" : ""}${issue ? " field--error" : ""}`}>
      <label htmlFor={id}>
        {label}
        {def.required && <span className="req" aria-hidden> *</span>}
      </label>
      {control}
      {def.description && <p className="hint">{def.description}</p>}
      {issue && <p className="error">{issue}</p>}
    </div>
  );

  switch (def.type) {
    case "string":
      if (def.enum) {
        return wrap(
          <select id={id} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
            <option value="">—</option>
            {def.enum.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>,
        );
      }
      return wrap(
        def.multiline ? (
          <textarea id={id} rows={4} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <input id={id} type="text" value={(value as string) ?? ""} maxLength={def.maxLength} onChange={(e) => onChange(e.target.value)} />
        ),
      );

    case "number":
      return wrap(
        <input
          id={id}
          type="number"
          min={def.min}
          max={def.max}
          step={def.integer ? 1 : "any"}
          value={typeof value === "number" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        />,
      );

    case "boolean":
      return wrap(
        <input id={id} type="checkbox" className="toggle" checked={value === true} onChange={(e) => onChange(e.target.checked)} />,
        true,
      );

    case "date":
      return wrap(
        <input
          id={id}
          type="datetime-local"
          value={typeof value === "string" ? toLocalInput(value) : ""}
          onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : undefined)}
        />,
      );

    case "json":
      return wrap(<JsonEditor id={id} value={value} onChange={onChange} />);

    case "object":
      return (
        <fieldset className="group">
          <legend>{label}</legend>
          <ObjectFields fields={def.fields} value={(value as Value) ?? {}} onChange={onChange} ctx={ctx} path={path} />
        </fieldset>
      );

    case "list": {
      const list = Array.isArray(value) ? value : [];
      const set = (next: unknown[]) => onChange(next);
      return (
        <fieldset className="group">
          <legend>
            {label} <span className="muted">({list.length})</span>
          </legend>
          {list.map((entry, i) => (
            <div key={i} className="list-row">
              <Field
                name={`#${i + 1}`}
                def={def.of}
                value={entry}
                path={`${path}.${i}`}
                ctx={ctx}
                onChange={(v) => set(list.map((e, j) => (j === i ? v : e)))}
              />
              <div className="list-actions">
                <button type="button" className="ghost" disabled={i === 0} onClick={() => set(swap(list, i, i - 1))} aria-label="Move up">↑</button>
                <button type="button" className="ghost" disabled={i === list.length - 1} onClick={() => set(swap(list, i, i + 1))} aria-label="Move down">↓</button>
                <button type="button" className="ghost danger" onClick={() => set(list.filter((_, j) => j !== i))} aria-label="Remove">✕</button>
              </div>
            </div>
          ))}
          <button type="button" className="secondary" onClick={() => set([...list, def.of.type === "object" ? {} : undefined])}>
            + Add
          </button>
        </fieldset>
      );
    }

    case "storageFile":
      return wrap(<StorageFileInput id={id} def={def} value={value as string | undefined} ctx={ctx} onChange={onChange} />);
  }
}

function swap<T>(list: T[], a: number, b: number): T[] {
  const next = [...list];
  [next[a], next[b]] = [next[b]!, next[a]!];
  return next;
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function JsonEditor(props: { id: string; value: unknown; onChange(v: unknown): void }) {
  const [text, setText] = useState(() => (props.value === undefined ? "" : JSON.stringify(props.value, null, 2)));
  const [invalid, setInvalid] = useState(false);
  return (
    <textarea
      id={props.id}
      rows={6}
      className={`mono${invalid ? " invalid" : ""}`}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        if (!e.target.value.trim()) {
          setInvalid(false);
          props.onChange(undefined);
          return;
        }
        try {
          props.onChange(JSON.parse(e.target.value));
          setInvalid(false);
        } catch {
          setInvalid(true);
        }
      }}
    />
  );
}

function StorageFileInput(props: {
  id: string;
  def: Extract<FieldDef, { type: "storageFile" }>;
  value?: string;
  ctx: FieldContext;
  onChange(v: string | undefined): void;
}) {
  const { def, value, ctx, onChange } = props;
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<string>();

  useEffect(() => {
    setPreview(undefined);
    if (!value || !/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(value)) return;
    let url: string | undefined;
    let cancelled = false;
    api
      .objectBlob(ctx.stage, value)
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setPreview(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [ctx.stage, value]);

  const upload = async (file: File) => {
    if (def.maxSizeMb && file.size > def.maxSizeMb * 1024 * 1024) {
      setError(`File is larger than ${def.maxSizeMb} MB.`);
      return;
    }
    if (!ctx.itemId && def.path.includes("{id}")) {
      setError("Set an item id before uploading.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const folder = def.path.replace("{id}", ctx.itemId).replace(/^\/+/, "");
      const name = `${folder}${folder && !folder.endsWith("/") ? "/" : ""}${file.name}`;
      await api.upload(ctx.stage, name, file);
      onChange(name);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="file">
      {preview && <img className="file-preview" src={preview} alt="" />}
      <div className="file-row">
        <input id={props.id} type="text" className="mono" placeholder={def.path} value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} />
        <button type="button" className="secondary" disabled={busy} onClick={() => fileInput.current?.click()}>
          {busy ? "Uploading…" : "Upload"}
        </button>
      </div>
      <input
        ref={fileInput}
        type="file"
        hidden
        accept={def.accept}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void upload(file);
        }}
      />
      {error && <p className="error">{error}</p>}
    </div>
  );
}
