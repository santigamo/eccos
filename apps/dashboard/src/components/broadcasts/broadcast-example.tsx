import { MACHINE_CLASS } from "../dashboard/plain-table";
import { ExampleStep } from "../sending/first-run";
import { WhatsAppPreview } from "../templates/whatsapp-preview";

const LIST = [
  ["+34 600 111 222", "Ana", "viernes"],
  ["+34 600 333 444", "Luis", "sábado"],
];

const REPORT = [
  ["Recipients", "2,431"],
  ["Sent", "1,170"],
  ["Delivered", "1,102"],
];

/** The /broadcasts first-run example: a list, the message each row becomes, the report. */
export function BroadcastExample() {
  return (
    <>
      <ExampleStep step={1} title="Your list" note="Paste it from a spreadsheet or upload a CSV.">
        <table className="w-full border-collapse font-mono text-xs">
          <thead>
            <tr className="border-b border-(--line) text-left text-muted-foreground">
              <th className="pb-1 font-normal">teléfono</th>
              <th className="pb-1 font-normal">nombre</th>
              <th className="pb-1 font-normal">recogida</th>
            </tr>
          </thead>
          <tbody>
            {LIST.map(([phone, name, day]) => (
              <tr key={phone} className="text-foreground">
                <td className="pt-1.5">{phone}</td>
                <td className="pt-1.5">{name}</td>
                <td className="pt-1.5">{day}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="m-0 mt-1 font-mono text-xs text-muted-foreground">… 2,429 more rows</p>
      </ExampleStep>
      <ExampleStep step={2} title="One message per row" note="Each person gets the template with their own details.">
        <WhatsAppPreview
          businessName="Your business"
          header={null}
          body="Hola {{1}}, tu pedido está listo. Puedes recogerlo el {{2}}."
          bodyValues={{ 1: "Ana", 2: "viernes" }}
          markValues
        />
      </ExampleStep>
      <ExampleStep step={3} title="The report" tag="sending" note="Who got it, who read it, and who failed and why.">
        <dl className="m-0 grid grid-cols-3 gap-2">
          {REPORT.map(([label, value]) => (
            <div key={label} className="flex flex-col gap-0.5">
              <dt className={MACHINE_CLASS}>{label}</dt>
              <dd className="m-0 font-pixel text-xl text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="m-0 mt-2 text-xs text-muted-foreground">
          640 read · 1,241 queued · <span className="text-destructive-foreground">20 failed</span>
        </p>
      </ExampleStep>
    </>
  );
}
