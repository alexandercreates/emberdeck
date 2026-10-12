import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import type { Item, ItemDiff, ItemTypeConfig, ListResult } from "@emberdeck/core";
import { api, ApiError, hasToken, type Meta, type StageInfo } from "./api";
import { ItemForm } from "./ItemForm";

type View = { kind: "items"; type: string } | { kind: "storage" } | { kind: "diff" };

export function App() {
  const [meta, setMeta] = useState<Meta>();
  const [error, setError] = useState<string>();
  const [stage, setStage] = useState<string>();
  const [view, setView] = useState<View>();

  useEffect(() => {
    if (!hasToken()) {
      setError("No session token. Open the link printed by `emberdeck studio`.");
      return;
    }
    api
      .meta()
      .then((m) => {
        setMeta(m);
        setStage(m.stages[0]?.name);
        const firstType = Object.keys(m.itemTypes)[0];
        setView(firstType ? { kind: "items", type: firstType } : { kind: "storage" });
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  if (error) return <Centered title="Can't connect" body={error} />;
  if (!meta || !stage || !view) return <Centered title="Loading…" />;

  const stageInfo = meta.stages.find((s) => s.name === stage)!;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span aria-hidden>🔥</span> emberdeck
        </div>
        <nav className="stages" aria-label="Stages">
          {meta.stages.map((s) => (
            <button
              key={s.name}
              className={`stage${s.name === stage ? " active" : ""}`}
              style={s.color ? ({ "--stage": s.color } as CSSProperties) : undefined}
              onClick={() => setStage(s.name)}
              title={s.projectId}
            >
              {s.protected && <span aria-label="protected">🔒 </span>}
              {s.name}
            </button>
          ))}
        </nav>
        <span className="muted small path" title={meta.configPath}>
          {meta.configPath}
        </span>
      </header>

      <aside className="sidebar">
        <p className="sidebar-title">Items</p>
        {Object.entries(meta.itemTypes).map(([name, t]) => (
          <button
            key={name}
            className={`nav${view.kind === "items" && view.type === name ? " active" : ""}`}
            onClick={() => setView({ kind: "items", type: name })}
          >
            {t.label ?? name}
          </button>
        ))}
        {Object.keys(meta.itemTypes).length === 0 && <p className="muted small">No item types configured.</p>}
        <p className="sidebar-title">Tools</p>
        <button className={`nav${view.kind === "storage" ? " active" : ""}`} onClick={() => setView({ kind: "storage" })}>
          Storage
        </button>
        <button className={`nav${view.kind === "diff" ? " active" : ""}`} onClick={() => setView({ kind: "diff" })}>
          Compare stages
        </button>
      </aside>

      <main className="main">
        {view.kind === "items" && (
          <ItemsView key={`${stage}/${view.type}`} stage={stageInfo} typeName={view.type} type={meta.itemTypes[view.type]!} />
        )}
        {view.kind === "storage" && <StorageView key={stage} stage={stageInfo} />}
        {view.kind === "diff" && <DiffView meta={meta} />}
      </main>
    </div>
  );
}

function Centered(props: { title: string; body?: string }) {
  return (
    <div className="centered">
      <h1>{props.title}</h1>
      {props.body && <p className="muted">{props.body}</p>}
    </div>
  );
}

function confirmProtected(stage: StageInfo, action: string): boolean {
  return !stage.protected || window.confirm(`"${stage.name}" is a protected stage.\n\n${action}?`);
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

function ItemsView(props: { stage: StageInfo; typeName: string; type: ItemTypeConfig }) {
  const { stage, typeName, type } = props;
  const isCollection = type.target.remoteConfig.key.includes("{id}");
  const [data, setData] = useState<{ etag: string; items: Item[] }>();
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<{ id: string; isNew: boolean; value: Record<string, unknown> }>();
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState("");

  const load = useCallback(() => {
    setError(undefined);
    api.items(stage.name, typeName).then(setData).catch((err: Error) => setError(err.message));
  }, [stage.name, typeName]);
  useEffect(load, [load]);

  const visible = useMemo(
    () => (data?.items ?? []).filter((i) => !filter || i.id.toLowerCase().includes(filter.toLowerCase())),
    [data, filter],
  );

  const save = async () => {
    if (!editing || !data) return;
    if (!/^[A-Za-z0-9_]+$/.test(editing.id)) {
      setIssues({ "": "Id may only contain letters, digits and underscores." });
      return;
    }
    if (!confirmProtected(stage, `Save ${typeName}/${editing.id}`)) return;
    setSaving(true);
    setIssues({});
    try {
      await api.saveItem(stage.name, typeName, editing.id, { value: editing.value, etag: data.etag });
      setEditing(undefined);
      load();
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.details)) {
        setIssues(Object.fromEntries((err.details as { path: string; message: string }[]).map((i) => [i.path, i.message])));
      } else {
        setIssues({ "": (err as Error).message });
      }
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm(`Delete ${typeName}/${id} from ${stage.name}?`)) return;
    if (!confirmProtected(stage, `Delete ${typeName}/${id}`)) return;
    try {
      await api.deleteItem(stage.name, typeName, id, data?.etag);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section>
      <div className="section-head">
        <div>
          <h1>{type.label ?? typeName}</h1>
          <p className="muted small">
            <code>{type.target.remoteConfig.key}</code>
            {type.target.remoteConfig.group && <> · group <code>{type.target.remoteConfig.group}</code></>}
            {" · "}
            {stage.projectId}
          </p>
        </div>
        <div className="actions">
          {isCollection && <input className="search" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />}
          <button className="ghost" onClick={load}>Reload</button>
          {isCollection && (
            <button className="primary" onClick={() => { setIssues({}); setEditing({ id: "", isNew: true, value: {} }); }}>
              New item
            </button>
          )}
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}
      {!data && !error && <p className="muted">Loading…</p>}

      {data && (
        <div className="cards">
          {visible.map((item) => (
            <article key={item.id} className="card">
              <div className="card-head">
                <strong>{item.id}</strong>
                {item.problems?.length ? <span className="pill warn" title={item.problems.map((p) => `${p.path}: ${p.message}`).join("\n")}>{item.problems.length} issue(s)</span> : null}
                {item.conditionalValues && <span className="pill">{Object.keys(item.conditionalValues).length} condition(s)</span>}
              </div>
              <pre className="mono preview">{JSON.stringify(item.value ?? "(in-app default)", null, 2)}</pre>
              <div className="card-actions">
                <button className="secondary" onClick={() => { setIssues({}); setEditing({ id: item.id, isNew: false, value: item.value ?? {} }); }}>
                  Edit
                </button>
                {isCollection && <button className="ghost danger" onClick={() => void remove(item.id)}>Delete</button>}
              </div>
            </article>
          ))}
          {visible.length === 0 && (
            <div className="empty">
              {isCollection ? <>No items yet in <strong>{stage.name}</strong>.</> : (
                <button className="primary" onClick={() => setEditing({ id: "default", isNew: true, value: {} })}>Create {type.label ?? typeName}</button>
              )}
            </div>
          )}
        </div>
      )}

      {editing && (
        <div className="drawer-backdrop" onClick={() => !saving && setEditing(undefined)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label="Edit item">
            <div className="drawer-head">
              <h2>{editing.isNew ? "New" : "Edit"} {type.label ?? typeName}</h2>
              <button className="ghost" onClick={() => setEditing(undefined)} aria-label="Close">✕</button>
            </div>
            {isCollection && (
              <div className="field">
                <label htmlFor="item-id">Id</label>
                <input
                  id="item-id"
                  className="mono"
                  value={editing.id}
                  disabled={!editing.isNew}
                  placeholder="summer_sale"
                  onChange={(e) => setEditing({ ...editing, id: e.target.value })}
                />
                <p className="hint">
                  Stored as <code>{type.target.remoteConfig.key.replace("{id}", editing.id || "…")}</code>
                </p>
              </div>
            )}
            {issues[""] && <div className="banner error">{issues[""]}</div>}
            <ItemForm
              fields={type.fields}
              value={editing.value}
              onChange={(value) => setEditing({ ...editing, value })}
              ctx={{ stage: stage.name, itemId: editing.id, issues }}
            />
            <div className="drawer-foot">
              <button className="ghost" onClick={() => setEditing(undefined)} disabled={saving}>Cancel</button>
              <button className="primary" onClick={() => void save()} disabled={saving || (isCollection && !editing.id)}>
                {saving ? "Publishing…" : `Publish to ${stage.name}`}
              </button>
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function StorageView(props: { stage: StageInfo }) {
  const { stage } = props;
  const [prefix, setPrefix] = useState("");
  const [data, setData] = useState<ListResult>();
  const [error, setError] = useState<string>();

  const load = useCallback(() => {
    setError(undefined);
    setData(undefined);
    api.listStorage(stage.name, prefix).then(setData).catch((err: Error) => setError(err.message));
  }, [stage.name, prefix]);
  useEffect(() => {
    if (stage.bucket) load();
  }, [load, stage.bucket]);

  if (!stage.bucket) {
    return <div className="empty">No <code>bucket</code> configured for {stage.name}.</div>;
  }

  const crumbs = prefix.split("/").filter(Boolean);
  const upload = async (files: FileList) => {
    if (!confirmProtected(stage, `Upload ${files.length} file(s)`)) return;
    try {
      for (const file of Array.from(files)) await api.upload(stage.name, prefix + file.name, file);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async (name: string) => {
    if (!window.confirm(`Delete ${name}?`) || !confirmProtected(stage, `Delete ${name}`)) return;
    try {
      await api.deleteObject(stage.name, name);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const open = async (name: string) => {
    const blob = await api.objectBlob(stage.name, name);
    window.open(URL.createObjectURL(blob), "_blank", "noopener");
  };

  return (
    <section>
      <div className="section-head">
        <div>
          <h1>Storage</h1>
          <p className="muted small">
            <button className="link" onClick={() => setPrefix("")}>{stage.bucket}</button>
            {crumbs.map((c, i) => (
              <span key={i}>
                {" / "}
                <button className="link" onClick={() => setPrefix(crumbs.slice(0, i + 1).join("/") + "/")}>{c}</button>
              </span>
            ))}
          </p>
        </div>
        <div className="actions">
          <button className="ghost" onClick={load}>Reload</button>
          <label className="button primary">
            Upload
            <input type="file" multiple hidden onChange={(e) => e.target.files && void upload(e.target.files)} />
          </label>
        </div>
      </div>
      {error && <div className="banner error">{error}</div>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && (
        <table className="table">
          <thead>
            <tr><th>Name</th><th>Type</th><th className="num">Size</th><th>Updated</th><th /></tr>
          </thead>
          <tbody>
            {data.prefixes.map((p) => (
              <tr key={p} className="clickable" onClick={() => setPrefix(p)}>
                <td>📁 {p.slice(prefix.length)}</td><td /><td /><td /><td />
              </tr>
            ))}
            {data.objects.filter((o) => o.name !== prefix).map((o) => (
              <tr key={o.name}>
                <td><button className="link" onClick={() => void open(o.name)}>{o.name.slice(prefix.length)}</button></td>
                <td className="muted">{o.contentType}</td>
                <td className="num">{formatBytes(o.size)}</td>
                <td className="muted">{o.updated ? new Date(o.updated).toLocaleString() : ""}</td>
                <td className="num"><button className="ghost danger" onClick={() => void remove(o.name)}>Delete</button></td>
              </tr>
            ))}
            {data.prefixes.length === 0 && data.objects.length === 0 && (
              <tr><td colSpan={5} className="muted">Empty.</td></tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Diff & promote
// ---------------------------------------------------------------------------

function DiffView(props: { meta: Meta }) {
  const { meta } = props;
  const names = meta.stages.map((s) => s.name);
  const types = Object.keys(meta.itemTypes);
  const [from, setFrom] = useState(names[0] ?? "");
  const [to, setTo] = useState(names[1] ?? names[0] ?? "");
  const [type, setType] = useState(types[0] ?? "");
  const [diff, setDiff] = useState<ItemDiff[]>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  const compare = useCallback(() => {
    if (!type || from === to) return;
    setError(undefined);
    setDiff(undefined);
    setSelected(new Set());
    api.diff(from, to, type).then(setDiff).catch((err: Error) => setError(err.message));
  }, [from, to, type]);
  useEffect(compare, [compare]);

  const promote = async () => {
    const target = meta.stages.find((s) => s.name === to)!;
    const ids = [...selected];
    if (!window.confirm(`Promote ${ids.length} ${type} item(s) from ${from} to ${to}?`)) return;
    if (!confirmProtected(target, `Publish to ${to}`)) return;
    setBusy(true);
    try {
      const report = await api.promote({ from, to, type, ids });
      setMessage(`Promoted ${report.items.length} item(s), ${report.files.filter((f) => f.action === "created" || f.action === "updated").length} file(s) copied.`);
      compare();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const promotable = (diff ?? []).filter((d) => d.status === "added" || d.status === "changed");

  return (
    <section>
      <div className="section-head">
        <div>
          <h1>Compare stages</h1>
          <p className="muted small">Promote default values (and referenced Storage files) from one stage to another.</p>
        </div>
      </div>
      <div className="toolbar">
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Item type">
          {types.map((t) => <option key={t} value={t}>{meta.itemTypes[t]?.label ?? t}</option>)}
        </select>
        <select value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From stage">
          {names.map((n) => <option key={n}>{n}</option>)}
        </select>
        <span aria-hidden>→</span>
        <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="To stage">
          {names.map((n) => <option key={n}>{n}</option>)}
        </select>
        <button className="primary" disabled={busy || selected.size === 0} onClick={() => void promote()}>
          {busy ? "Promoting…" : `Promote ${selected.size || ""} to ${to}`}
        </button>
      </div>
      {from === to && <p className="muted">Pick two different stages.</p>}
      {message && <div className="banner ok">{message}</div>}
      {error && <div className="banner error">{error}</div>}
      {diff && (
        <table className="table">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={promotable.length > 0 && selected.size === promotable.length}
                  onChange={(e) => setSelected(e.target.checked ? new Set(promotable.map((d) => d.id)) : new Set())}
                />
              </th>
              <th>Item</th>
              <th>Status</th>
              <th>Changes</th>
            </tr>
          </thead>
          <tbody>
            {diff.map((d) => {
              const canPromote = d.status === "added" || d.status === "changed";
              return (
                <tr key={d.id}>
                  <td>
                    <input
                      type="checkbox"
                      disabled={!canPromote}
                      checked={selected.has(d.id)}
                      aria-label={`Select ${d.id}`}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(d.id);
                        else next.delete(d.id);
                        setSelected(next);
                      }}
                    />
                  </td>
                  <td><strong>{d.id}</strong></td>
                  <td><span className={`pill status-${d.status}`}>{d.status === "added" ? `only in ${from}` : d.status === "removed" ? `only in ${to}` : d.status}</span></td>
                  <td className="muted">
                    {[d.changedFields?.join(", "), d.conditionalValuesDiffer ? "conditional values" : ""].filter(Boolean).join(" · ")}
                  </td>
                </tr>
              );
            })}
            {diff.length === 0 && <tr><td colSpan={4} className="muted">No items in either stage.</td></tr>}
          </tbody>
        </table>
      )}
    </section>
  );
}
