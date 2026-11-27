import { useMemo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ListTable } from "../../lib/list-file";
import {
  type CountryCode,
  countryName,
  countryOptions,
} from "../../lib/phone-number";
import {
  dataRows,
  type ListCheck,
  type Mapping,
  type Slot,
  type Source,
} from "../../lib/recipient-list";
import { fmtCount } from "../../ui";
import {
  IDENTITY_TIER,
  MACHINE_CLASS,
  SECONDARY_TIER,
} from "../dashboard/plain-table";

const FIXED = "fixed";
const UNSET = "unset";

const letter = (column: number) =>
  String.fromCharCode(65 + (column % 26)) +
  (column >= 26 ? String(Math.floor(column / 26)) : "");
const plural = (n: number, one: string, many: string) =>
  `${fmtCount(n)} ${n === 1 ? one : many}`;

/**
 * The list once it is read: where it came from, which column fills what the
 * template needs (with row 1 read back), and the two decisions only the
 * operator can make: the country code of numbers written without one, and what
 * an empty cell does. Neither is ever guessed silently.
 */
export function ColumnMapping({
  table,
  slots,
  mapping,
  check,
  onMapping,
  onReplace,
}: {
  table: ListTable;
  slots: Slot[];
  mapping: Mapping;
  check: ListCheck;
  onMapping: (mapping: Mapping) => void;
  onReplace: () => void;
}) {
  const first = table.rows[0] ?? [];
  const firstData = dataRows(table, mapping.header)[0] ?? [];
  const columns = Array.from({ length: table.columns }, (_, i) => ({
    value: String(i),
    label: `${letter(i)} · ${(mapping.header ? first[i] : firstData[i]) || "(empty)"}`,
  }));
  const countries = useMemo(countryOptions, []);
  const total = check.rows.length;
  const row1 = check.rows[0];

  const setSource = (slot: Slot, source: Source) =>
    onMapping({
      ...mapping,
      sources: { ...mapping.sources, [slot.id]: source },
    });
  const fallbackSlots = slots.filter((slot) => {
    const source = mapping.sources[slot.id];
    return (check.empty[slot.id] ?? 0) > 0 && source && "column" in source;
  });

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-(--line) p-5">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-mono text-sm break-all text-foreground">
            {table.name ?? "Pasted list"}
          </span>
          <span className={SECONDARY_TIER}>
            {plural(total, "row", "rows")} ·{" "}
            {plural(table.columns, "column", "columns")}
          </span>
          <span className="mt-1 flex items-center gap-2">
            <Checkbox
              id="list-header"
              checked={mapping.header}
              onCheckedChange={(header) =>
                onMapping({ ...mapping, header: header === true })
              }
            />
            <label
              htmlFor="list-header"
              className={`cursor-pointer ${SECONDARY_TIER}`}
            >
              First row is a header
            </label>
          </span>
        </div>
        <Button type="button" variant="outline" onClick={onReplace}>
          Replace
        </Button>
      </div>

      <div className="overflow-x-auto p-5">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr>
              {["The template needs", "Column in your list", "Row 1 reads"].map(
                (heading) => (
                  <th
                    key={heading}
                    className={`pb-2 pr-4 font-medium ${MACHINE_CLASS}`}
                  >
                    {heading}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            <MappingRow
              label={<span className={IDENTITY_TIER}>Phone number</span>}
              reads={row1?.to}
            >
              <ColumnSelect
                label="Phone number"
                value={mapping.phone === null ? UNSET : String(mapping.phone)}
                options={columns}
                onChange={(value) =>
                  onMapping({
                    ...mapping,
                    phone: value === UNSET ? null : Number(value),
                  })
                }
              />
            </MappingRow>
            {slots.map((slot, i) => {
              const source = mapping.sources[slot.id] ?? null;
              const value = !source
                ? UNSET
                : "fixed" in source
                  ? FIXED
                  : String(source.column);
              return (
                <MappingRow
                  key={slot.id}
                  label={
                    <span className="flex flex-col">
                      <span className="font-mono text-sm text-foreground">
                        {slot.label}
                      </span>
                      {slot.example ? (
                        <span className={SECONDARY_TIER}>
                          e.g. {slot.example}
                        </span>
                      ) : null}
                    </span>
                  }
                  reads={row1?.values[i]}
                >
                  <div className="flex flex-col gap-2">
                    <ColumnSelect
                      label={slot.label}
                      value={value}
                      options={[
                        ...columns,
                        { value: FIXED, label: "Same text for everyone" },
                      ]}
                      onChange={(next) =>
                        setSource(
                          slot,
                          next === UNSET
                            ? null
                            : next === FIXED
                              ? { fixed: "" }
                              : { column: Number(next) },
                        )
                      }
                    />
                    {source && "fixed" in source ? (
                      <Input
                        aria-label={`Text for ${slot.label}`}
                        value={source.fixed}
                        placeholder={slot.example ?? undefined}
                        onChange={(event) =>
                          setSource(slot, { fixed: event.target.value })
                        }
                      />
                    ) : null}
                  </div>
                </MappingRow>
              );
            })}
          </tbody>
        </table>
      </div>

      {check.noCode > 0 ? (
        <Decision
          title={`${plural(check.noCode, "number has", "numbers have")} no country code`}
          note={
            mapping.country
              ? `${plural(check.national, "takes", "take")} the code of ${countryName(mapping.country)}; the rest are not valid ${countryName(mapping.country)} numbers and are skipped. A wrong code messages a stranger abroad.`
              : "Choose their country, or they are skipped. A wrong code messages a stranger abroad."
          }
        >
          <span className={SECONDARY_TIER}>Add</span>
          <Select
            value={mapping.country ?? ""}
            onValueChange={(code) =>
              code && onMapping({ ...mapping, country: code as CountryCode })
            }
          >
            <SelectTrigger
              aria-label="Country code"
              className="w-48 rounded-none"
            >
              <SelectValue>
                {(code: string) =>
                  countries.find((option) => option.code === code)?.label ??
                  "Choose"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent align="end">
              {countries.map((option) => (
                <SelectItem key={option.code} value={option.code}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Decision>
      ) : null}

      {check.decimals > 0 ? (
        <p
          className={`m-0 border-t border-(--line) px-5 py-3 ${SECONDARY_TIER}`}
        >
          {plural(check.decimals, "number ends", "numbers end")} in .00, which a
          spreadsheet adds to a number column: read without it. Format the
          column as text next time.
        </p>
      ) : null}

      {fallbackSlots.map((slot) => {
        const fallback = mapping.fallback[slot.id];
        const setFallback = (text: string | undefined) => {
          const { [slot.id]: _gone, ...rest } = mapping.fallback;
          onMapping({
            ...mapping,
            fallback: text === undefined ? rest : { ...rest, [slot.id]: text },
          });
        };
        return (
          <Decision
            key={slot.id}
            title={
              <>
                {plural(check.empty[slot.id] ?? 0, "row has", "rows have")} no{" "}
                <span className="font-mono">{slot.label}</span>
              </>
            }
            note="Meta refuses a message with an empty value."
          >
            {fallback !== undefined ? (
              <Input
                aria-label={`Text for an empty ${slot.label}`}
                className="w-40"
                value={fallback}
                placeholder={slot.example ?? "Text"}
                onChange={(event) => setFallback(event.target.value)}
              />
            ) : null}
            <Select
              value={fallback === undefined ? "skip" : "text"}
              onValueChange={(next) =>
                setFallback(next === "text" ? "" : undefined)
              }
            >
              <SelectTrigger
                aria-label={`When ${slot.label} is empty`}
                className="w-40 rounded-none"
              >
                <SelectValue>
                  {(next: string) =>
                    next === "text" ? "Use this text" : "Skip the row"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="skip">Skip the row</SelectItem>
                <SelectItem value="text">Use this text</SelectItem>
              </SelectContent>
            </Select>
          </Decision>
        );
      })}
    </div>
  );
}

function MappingRow({
  label,
  reads,
  children,
}: { label: ReactNode; reads: string | undefined; children: ReactNode }) {
  return (
    <tr className="align-top">
      <td className="py-2 pr-4">{label}</td>
      <td className="w-64 py-2 pr-4">{children}</td>
      <td className="py-2 font-mono text-sm break-all text-foreground">
        {reads || <span className="text-muted-foreground">—</span>}
      </td>
    </tr>
  );
}

function ColumnSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={(next) => next && onChange(next)}>
      <SelectTrigger
        aria-label={`Column for ${label}`}
        className="w-full rounded-none"
      >
        <SelectValue>
          {(current: string) =>
            options.find((option) => option.value === current)?.label ??
            "Choose a column"
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A choice only the operator can make, on the amber rail: something here can go wrong for a real person. */
function Decision({
  title,
  note,
  children,
}: { title: ReactNode; note: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border-t border-l-2 border-t-(--line) border-l-warning px-5 py-3">
      <div className="flex min-w-0 flex-col">
        <span className={IDENTITY_TIER}>{title}</span>
        <span className={SECONDARY_TIER}>{note}</span>
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
