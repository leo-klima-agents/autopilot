/**
 * Generic schema-driven config form: renders each ConfigSchemaProperty of a
 * strategy's hand-rolled JSON schema. No per-strategy form code anywhere.
 * Wad-typed fields travel as decimal strings (the schemas type them "string").
 */
import type { ConfigSchema } from "@aero-autopilot/core/strategies";

interface Props {
  schema: ConfigSchema;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}

export function SchemaForm({ schema, value, onChange }: Props) {
  const set = (key: string, v: unknown) => onChange({ ...value, [key]: v });

  return (
    <>
      {Object.entries(schema.properties).map(([key, prop]) => {
        // pool allowlists and other array props default to the full universe;
        // exposing them as raw text fields would invite invalid addresses
        if (prop.type === "array") return null;
        const current = value[key] ?? prop.default;
        const id = `cfg-${key}`;
        return (
          <div className="field" key={key}>
            <label htmlFor={id}>
              {key}
              <span className="hint">{prop.description}</span>
            </label>
            {prop.type === "boolean" ? (
              <input
                id={id}
                type="checkbox"
                checked={Boolean(current)}
                onChange={(e) => set(key, e.target.checked)}
              />
            ) : prop.enum ? (
              <select id={id} value={String(current)} onChange={(e) => set(key, e.target.value)}>
                {prop.enum.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            ) : prop.type === "string" ? (
              <input id={id} value={String(current ?? "")} onChange={(e) => set(key, e.target.value)} />
            ) : (
              <input
                id={id}
                type="number"
                value={Number(current ?? 0)}
                min={prop.minimum}
                max={prop.maximum}
                step={prop.type === "integer" ? 1 : "any"}
                onChange={(e) =>
                  set(key, prop.type === "integer" ? Math.round(e.target.valueAsNumber) : e.target.valueAsNumber)
                }
              />
            )}
          </div>
        );
      })}
    </>
  );
}
