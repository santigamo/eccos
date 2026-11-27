import { ExampleStep } from "../sending/first-run";
import { WhatsAppPreview } from "../templates/whatsapp-preview";

/** The /scheduled first-run example: booked, moved under the same key, sent on time. */
export function ScheduledExample() {
  return (
    <>
      <ExampleStep
        step={1}
        title="An appointment is booked"
        tag="pending"
        note="Your system schedules the reminder under the appointment's id."
      >
        <p className="m-0 font-mono text-xs text-muted-foreground">appt-8812</p>
        <p className="m-0 mt-1 text-lg font-medium text-foreground">Fri 20 Nov, 09:00</p>
        <p className="m-0 mt-1 font-mono text-[11px] text-muted-foreground">
          appointment_reminder · es · +34 600 111 222
        </p>
      </ExampleStep>
      <ExampleStep
        step={2}
        title="The appointment moves"
        tag="pending"
        note="Same id, new time. Cancel it and nothing is sent."
      >
        <p className="m-0 font-mono text-xs text-muted-foreground">appt-8812</p>
        <p className="m-0 mt-1 text-lg font-medium text-foreground">Sat 21 Nov, 11:30</p>
        <p className="m-0 mt-1 text-xs text-muted-foreground">
          was <s>Fri 20 Nov, 09:00</s>
        </p>
      </ExampleStep>
      <ExampleStep
        step={3}
        title="Ana gets it on time"
        tag="sent"
        note="On time, or not at all: one that cannot go out within the hour is never sent."
      >
        <WhatsAppPreview
          businessName="Your business"
          header={null}
          body="Hola {{1}}, te recordamos tu cita de hoy a las {{2}}."
          bodyValues={{ 1: "Ana", 2: "13:30" }}
          markValues
        />
      </ExampleStep>
    </>
  );
}
