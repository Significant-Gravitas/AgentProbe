import { useEffect, useMemo, useState } from "react";
import { jsonBody } from "../api/client.ts";
import type {
  Preset,
  PresetResponse,
  ScenariosResponse,
  ServerRequest,
  SuitesResponse,
} from "../api/types.ts";
import {
  Button,
  Card,
  Checkbox,
  ErrorBanner,
  Field,
  Loading,
  PageHeader,
  SimpleSelect,
  Tag,
  TextInput,
} from "../ui/index.tsx";
import {
  ScenarioDetailsModal,
  type ScenarioDetailsTarget,
} from "./ScenarioDetailsModal.tsx";

type SelectionKey = string; // `${file}::${id}`

function key(file: string, id: string): SelectionKey {
  return `${file}::${id}`;
}

export function PresetEditorView({
  presetId,
  request,
  navigate,
}: {
  presetId: string;
  request: ServerRequest;
  navigate: (href: string) => void;
}) {
  const [preset, setPreset] = useState<Preset | null>(null);
  const [scenarios, setScenarios] = useState<ScenariosResponse | null>(null);
  const [suites, setSuites] = useState<SuitesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [personas, setPersonas] = useState("");
  const [rubric, setRubric] = useState("");
  const [repeat, setRepeat] = useState(1);
  const [parallelEnabled, setParallelEnabled] = useState(false);
  const [parallelLimit, setParallelLimit] = useState(2);
  const [dryRun, setDryRun] = useState(false);
  const [selected, setSelected] = useState<Set<SelectionKey>>(new Set());
  const [filter, setFilter] = useState("");
  const [tagFilter, setTagFilter] = useState<string>("");
  const [priorityFilter, setPriorityFilter] = useState<string>("");
  const [selectionFilter, setSelectionFilter] = useState<
    "all" | "selected" | "unselected"
  >("all");
  const [detailsTarget, setDetailsTarget] =
    useState<ScenarioDetailsTarget | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      request<PresetResponse>(`/api/presets/${encodeURIComponent(presetId)}`),
      request<ScenariosResponse>("/api/scenarios"),
      request<SuitesResponse>("/api/suites"),
    ])
      .then(([presetResponse, scenariosResponse, suitesResponse]) => {
        if (cancelled) return;
        const p = presetResponse.preset;
        setPreset(p);
        setScenarios(scenariosResponse);
        setSuites(suitesResponse);
        setName(p.name);
        setDescription(p.description ?? "");
        setEndpoint(p.endpoint);
        setPersonas(p.personas);
        setRubric(p.rubric);
        setRepeat(p.repeat);
        setParallelEnabled(p.parallel.enabled);
        setParallelLimit(p.parallel.limit ?? 2);
        setDryRun(p.dry_run);
        setSelected(
          new Set(p.selection.map((entry) => key(entry.file, entry.id))),
        );
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [request, presetId]);

  const allTags = useMemo(() => {
    if (!scenarios) return [];
    const tags = new Set<string>();
    for (const scenario of scenarios.scenarios) {
      for (const tag of scenario.tags) tags.add(tag);
    }
    return [...tags].sort();
  }, [scenarios]);

  const allPriorities = useMemo(() => {
    if (!scenarios) return [];
    const priorities = new Set<string>();
    for (const scenario of scenarios.scenarios) {
      if (scenario.priority) priorities.add(scenario.priority);
    }
    return [...priorities].sort();
  }, [scenarios]);

  const filteredScenarios = useMemo(() => {
    if (!scenarios) return [];
    const f = filter.trim().toLowerCase();
    return scenarios.scenarios.filter((scenario) => {
      if (
        f &&
        !scenario.id.toLowerCase().includes(f) &&
        !scenario.name.toLowerCase().includes(f) &&
        !(scenario.description ?? "").toLowerCase().includes(f) &&
        !scenario.sourcePath.toLowerCase().includes(f)
      ) {
        return false;
      }
      if (tagFilter && !scenario.tags.includes(tagFilter)) return false;
      if (priorityFilter && scenario.priority !== priorityFilter) return false;
      if (selectionFilter !== "all") {
        const isSelected = selected.has(key(scenario.sourcePath, scenario.id));
        if (selectionFilter === "selected" && !isSelected) return false;
        if (selectionFilter === "unselected" && isSelected) return false;
      }
      return true;
    });
  }, [scenarios, filter, tagFilter, priorityFilter, selectionFilter, selected]);

  const endpointSuites = useMemo(
    () => suites?.suites.filter((suite) => suite.schema === "endpoints") ?? [],
    [suites],
  );
  const personaSuites = useMemo(
    () => suites?.suites.filter((suite) => suite.schema === "personas") ?? [],
    [suites],
  );
  const rubricSuites = useMemo(
    () => suites?.suites.filter((suite) => suite.schema === "rubrics") ?? [],
    [suites],
  );

  const toggle = (file: string, id: string) => {
    const k = key(file, id);
    const next = new Set(selected);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setSelected(next);
  };

  const selectAllFiltered = () => {
    const next = new Set(selected);
    for (const scenario of filteredScenarios) {
      next.add(key(scenario.sourcePath, scenario.id));
    }
    setSelected(next);
  };

  const clearAllFiltered = () => {
    const next = new Set(selected);
    for (const scenario of filteredScenarios) {
      next.delete(key(scenario.sourcePath, scenario.id));
    }
    setSelected(next);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // Re-derive selection in scenario-list order so saved positions are stable.
      if (!scenarios) throw new Error("Scenarios not loaded.");
      const selectionList: Array<{ file: string; id: string }> = [];
      for (const scenario of scenarios.scenarios) {
        const k = key(scenario.sourcePath, scenario.id);
        if (selected.has(k)) {
          selectionList.push({ file: scenario.sourcePath, id: scenario.id });
        }
      }
      if (selectionList.length === 0) {
        throw new Error("Select at least one scenario.");
      }
      await request(
        `/api/presets/${encodeURIComponent(presetId)}`,
        jsonBody("PUT", {
          name: name.trim(),
          description: description.trim() || null,
          endpoint,
          personas,
          rubric,
          selection: selectionList,
          parallel: {
            enabled: parallelEnabled,
            limit: parallelEnabled ? parallelLimit : null,
          },
          repeat,
          dry_run: dryRun,
        }),
      );
      navigate(`/presets/${encodeURIComponent(presetId)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (error && !preset) return <ErrorBanner message={error} />;
  if (!preset || !scenarios || !suites) return <Loading />;

  return (
    <>
      <PageHeader
        eyebrow="Edit Preset"
        title={name || preset.name}
        meta={`${selected.size} scenario${selected.size === 1 ? "" : "s"} selected`}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() =>
                navigate(`/presets/${encodeURIComponent(presetId)}`)
              }
            >
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </>
        }
      />

      {error ? <ErrorBanner message={error} /> : null}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-4 mb-6">
        <Card className="p-4 flex flex-col gap-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Name">
              <TextInput
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                required
              />
            </Field>
            <Field label="Description">
              <TextInput
                value={description}
                onChange={(e) => setDescription(e.currentTarget.value)}
                placeholder="Short summary"
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Endpoint">
              <SimpleSelect
                value={endpoint}
                onValueChange={setEndpoint}
                options={endpointSuites.map((suite) => ({
                  value: suite.relativePath,
                  label: suite.relativePath,
                }))}
                emptyLabel="No endpoint suites"
              />
            </Field>
            <Field label="Personas">
              <SimpleSelect
                value={personas}
                onValueChange={setPersonas}
                options={personaSuites.map((suite) => ({
                  value: suite.relativePath,
                  label: suite.relativePath,
                }))}
                emptyLabel="No persona suites"
              />
            </Field>
            <Field label="Rubric">
              <SimpleSelect
                value={rubric}
                onValueChange={setRubric}
                options={rubricSuites.map((suite) => ({
                  value: suite.relativePath,
                  label: suite.relativePath,
                }))}
                emptyLabel="No rubric suites"
              />
            </Field>
          </div>
        </Card>
        <Card className="p-4 flex flex-col gap-3">
          <Field label="Repeat">
            <TextInput
              type="number"
              min={1}
              value={repeat}
              onChange={(e) => setRepeat(Number(e.currentTarget.value))}
            />
          </Field>
          <Field label="Parallel">
            <div className="flex items-center gap-3">
              <Checkbox
                checked={parallelEnabled}
                onChange={setParallelEnabled}
                label="Enabled"
              />
              <TextInput
                type="number"
                min={1}
                value={parallelLimit}
                disabled={!parallelEnabled}
                onChange={(e) =>
                  setParallelLimit(Number(e.currentTarget.value))
                }
                className="w-20"
              />
            </div>
          </Field>
          <Field label="Mode">
            <Checkbox
              checked={dryRun}
              onChange={setDryRun}
              label="Dry run by default"
            />
          </Field>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="p-3 border-b border-border flex flex-wrap items-center gap-2">
          <TextInput
            placeholder="Filter by id, name, or path…"
            value={filter}
            onChange={(e) => setFilter(e.currentTarget.value)}
            className="max-w-xs"
          />
          <SimpleSelect
            value={tagFilter || "__all_tags__"}
            onValueChange={(value) =>
              setTagFilter(value === "__all_tags__" ? "" : value)
            }
            className="max-w-xs"
            options={[
              { value: "__all_tags__", label: "All tags" },
              ...allTags.map((tag) => ({ value: tag, label: tag })),
            ]}
          />
          <SimpleSelect
            value={priorityFilter || "__all_priorities__"}
            onValueChange={(value) =>
              setPriorityFilter(value === "__all_priorities__" ? "" : value)
            }
            className="max-w-xs"
            options={[
              { value: "__all_priorities__", label: "All priorities" },
              ...allPriorities.map((priority) => ({
                value: priority,
                label: priority,
              })),
            ]}
          />
          <SimpleSelect
            value={selectionFilter}
            onValueChange={(value) =>
              setSelectionFilter(value as "all" | "selected" | "unselected")
            }
            className="max-w-xs"
            options={[
              { value: "all", label: "All scenarios" },
              { value: "selected", label: "Included only" },
              { value: "unselected", label: "Not included" },
            ]}
          />
          <div className="flex-1" />
          <span className="text-xs text-muted-foreground mr-2">
            {filteredScenarios.length} matching · {selected.size} selected
          </span>
          <Button variant="secondary" size="sm" onClick={selectAllFiltered}>
            Select shown
          </Button>
          <Button variant="ghost" size="sm" onClick={clearAllFiltered}>
            Clear shown
          </Button>
        </div>
        <div className="max-h-[480px] overflow-y-auto divide-y divide-border">
          {filteredScenarios.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground text-sm">
              No scenarios match.
            </div>
          ) : (
            filteredScenarios.map((scenario) => {
              const k = key(scenario.sourcePath, scenario.id);
              const checked = selected.has(k);
              return (
                <div
                  key={k}
                  className={`flex items-start gap-3 px-3 py-2.5 hover:bg-secondary ${checked ? "bg-primary/5" : ""}`}
                >
                  <label className="flex items-start gap-3 flex-1 min-w-0 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(scenario.sourcePath, scenario.id)}
                      className="size-4 mt-0.5 accent-primary shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="text-sm font-medium text-foreground">
                          {scenario.name || scenario.id}
                        </span>
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {scenario.id}
                        </span>
                        {scenario.priority ? (
                          <Tag tone="info">{scenario.priority}</Tag>
                        ) : null}
                      </div>
                      {scenario.description ? (
                        <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                          {scenario.description}
                        </div>
                      ) : null}
                      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                        {scenario.tags.slice(0, 5).map((tag) => (
                          <Tag key={tag}>{tag}</Tag>
                        ))}
                        <span className="text-[10px] text-muted-foreground/70 font-mono">
                          {scenario.sourcePath}
                        </span>
                      </div>
                    </div>
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0 self-start"
                    onClick={() =>
                      setDetailsTarget({
                        file: scenario.sourcePath,
                        id: scenario.id,
                        name: scenario.name,
                        description: scenario.description,
                        tags: scenario.tags,
                        priority: scenario.priority,
                      })
                    }
                  >
                    Details
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </Card>
      <ScenarioDetailsModal
        open={detailsTarget != null}
        target={detailsTarget}
        request={request}
        onClose={() => setDetailsTarget(null)}
      />
    </>
  );
}
