import { type FormEvent, useEffect, useMemo, useState } from "react";
import { jsonBody } from "../api/client.ts";
import type { ServerRequest, SuitesResponse } from "../api/types.ts";
import {
  Button,
  Checkbox,
  ErrorBanner,
  Field,
  Modal,
  SimpleSelect,
  Tag,
  Textarea,
  TextInput,
} from "../ui/index.tsx";

export type RunLaunchOptions = {
  presetId: string;
  presetName: string;
  defaults: {
    endpoint: string;
    personas: string;
    rubric: string;
    parallelEnabled: boolean;
    parallelLimit: number | null;
    repeat: number;
    dryRun: boolean;
  };
};

export function RunLaunchModal({
  open,
  options,
  request,
  onClose,
  onLaunched,
  suites,
}: {
  open: boolean;
  options: RunLaunchOptions | null;
  request: ServerRequest;
  onClose: () => void;
  onLaunched: (runId: string) => void;
  suites: SuitesResponse | null;
}) {
  const [endpoint, setEndpoint] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [personas, setPersonas] = useState("");
  const [rubric, setRubric] = useState("");
  const [parallelEnabled, setParallelEnabled] = useState(false);
  const [parallelLimit, setParallelLimit] = useState(2);
  const [repeat, setRepeat] = useState(1);
  const [dryRun, setDryRun] = useState(false);
  const [label, setLabel] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open || !options) return;
    setEndpoint(options.defaults.endpoint);
    setBaseUrl("");
    setPersonas(options.defaults.personas);
    setRubric(options.defaults.rubric);
    setParallelEnabled(options.defaults.parallelEnabled);
    setParallelLimit(options.defaults.parallelLimit ?? 2);
    setRepeat(options.defaults.repeat);
    setDryRun(options.defaults.dryRun);
    setLabel("");
    setNotes("");
    setError(null);
  }, [open, options]);

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

  const detectedTransport = useMemo(() => {
    const path = endpoint.toLowerCase();
    if (path.includes("autogpt")) return "autogpt";
    if (path.includes("openclaw")) return "openclaw";
    if (path.includes("opencode")) return "opencode";
    return "custom";
  }, [endpoint]);

  if (!options) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const overrides: Record<string, unknown> = {
        parallel: {
          enabled: parallelEnabled,
          limit: parallelEnabled ? parallelLimit : undefined,
        },
        repeat,
        dry_run: dryRun,
      };
      if (endpoint && endpoint !== options.defaults.endpoint) {
        overrides.endpoint = endpoint;
      }
      const trimmedBaseUrl = baseUrl.trim();
      if (trimmedBaseUrl) {
        overrides.base_url = trimmedBaseUrl;
      }
      if (personas && personas !== options.defaults.personas) {
        overrides.personas = personas;
      }
      if (rubric && rubric !== options.defaults.rubric) {
        overrides.rubric = rubric;
      }

      const body: Record<string, unknown> = { overrides };
      if (label.trim()) body.label = label.trim();
      if (notes.trim()) body.notes = notes.trim();

      const response = await request<{ run_id: string }>(
        `/api/presets/${encodeURIComponent(options.presetId)}/runs`,
        jsonBody("POST", body),
      );
      onLaunched(response.run_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Run ${options.presetName}`}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" form="run-launch-form" disabled={submitting}>
            {submitting ? "Starting…" : "Start run"}
          </Button>
        </>
      }
    >
      {error ? <ErrorBanner message={error} /> : null}
      <form
        id="run-launch-form"
        onSubmit={submit}
        className="flex flex-col gap-4"
      >
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-2">
            Endpoint
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-[2fr_auto] gap-2 items-center">
            <SimpleSelect
              value={endpoint}
              onValueChange={setEndpoint}
              options={[
                ...endpointSuites.map((suite) => ({
                  value: suite.relativePath,
                  label: suite.relativePath,
                })),
                ...(endpoint &&
                !endpointSuites.find((suite) => suite.relativePath === endpoint)
                  ? [{ value: endpoint, label: endpoint }]
                  : []),
              ]}
              emptyLabel="No endpoint suites found"
            />
            <Tag tone={detectedTransport === "custom" ? "warn" : "info"}>
              {detectedTransport}
            </Tag>
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            Pick a different endpoint YAML to retarget the run (e.g. an autogpt
            staging endpoint vs. an openclaw gateway).
          </div>
        </div>

        <Field
          label="Base URL override"
          hint="Replaces connection.base_url (HTTP) or connection.url (WebSocket) from the endpoint YAML for this run only. Leave blank to use the YAML default."
        >
          <TextInput
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.currentTarget.value)}
            placeholder="e.g. https://staging.autogpt.example or ws://10.0.0.5:18789"
          />
        </Field>

        <details className="rounded-md border border-border bg-secondary p-3">
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
            Override personas / rubric
          </summary>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
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
        </details>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Parallel">
            <div className="flex items-center gap-2">
              <Checkbox
                checked={parallelEnabled}
                onChange={setParallelEnabled}
                label="Enabled"
              />
            </div>
          </Field>
          <Field label="Parallel limit">
            <TextInput
              type="number"
              min={1}
              value={parallelLimit}
              disabled={!parallelEnabled}
              onChange={(e) => setParallelLimit(Number(e.currentTarget.value))}
            />
          </Field>
          <Field label="Repeat">
            <TextInput
              type="number"
              min={1}
              value={repeat}
              onChange={(e) => setRepeat(Number(e.currentTarget.value))}
            />
          </Field>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field
            label="Run name"
            hint="Shows in the run list — useful for comparing runs later."
          >
            <TextInput
              value={label}
              onChange={(e) => setLabel(e.currentTarget.value)}
              placeholder="e.g. autogpt-staging baseline"
              maxLength={200}
            />
          </Field>
          <Field label="Mode">
            <Checkbox checked={dryRun} onChange={setDryRun} label="Dry run" />
          </Field>
        </div>

        <Field
          label="Notes"
          hint="Optional context — diff vs. last run, hypotheses, etc."
        >
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.currentTarget.value)}
            rows={3}
            maxLength={4000}
            placeholder="Why this run?"
          />
        </Field>
      </form>
    </Modal>
  );
}
