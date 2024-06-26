import { env } from "@/env.mjs";
import { LogEvents } from "@midday/events/events";
import { setupLogSnag } from "@midday/events/server";
import { Events } from "@midday/jobs";
import { client } from "@midday/jobs/src/client";
import {
  NotificationTypes,
  TriggerEvents,
  triggerBulk,
} from "@midday/notification";
import { createClient } from "@midday/supabase/server";
import { stripSpecialCharacters } from "@midday/utils";
import { decode } from "base64-arraybuffer";
import { nanoid } from "nanoid";
import { headers } from "next/headers";
import { Resend } from "resend";

export const runtime = "nodejs";
export const maxDuration = 300; // 5min
export const dynamic = "force-dynamic";

const resend = new Resend(env.RESEND_API_KEY);

// https://postmarkapp.com/support/article/800-ips-for-firewalls#webhooks
const ipRange = [
  "3.134.147.250",
  "50.31.156.6",
  "50.31.156.77",
  "18.217.206.57",
];

export async function POST(req: Request) {
  const supabase = createClient({ admin: true });
  const res = await req.json();
  const clientIP = headers().get("x-forwarded-for") ?? "";

  const logsnag = await setupLogSnag();

  logsnag.track({
    event: LogEvents.InboxInbound.name,
    icon: LogEvents.InboxInbound.icon,
    channel: LogEvents.InboxInbound.channel,
  });

  if (res?.OriginalRecipient && ipRange.includes(clientIP)) {
    const email = res?.OriginalRecipient;
    const [inboxId] = email.split("@");

    const { data: teamData } = await supabase
      .from("teams")
      .select("id, inbox_email")
      .eq("inbox_id", inboxId)
      .single()
      .throwOnError();

    const attachments = res?.Attachments;
    const subject = res.Subject.length > 0 ? res.Subject : "No subject";
    const contentType = "application/pdf";

    if (teamData?.inbox_email) {
      try {
        // NOTE: Send original email to company email
        await resend.emails.send({
          from: `${res.FromFull.Name} <inbox@midday.ai>`,
          to: [teamData.inbox_email],
          subject,
          text: res.TextBody,
          html: res.HtmlBody,
          attachments: attachments?.map((a) => ({
            filename: a.Name,
            content: a.Content,
          })),
          headers: {
            "X-Entity-Ref-ID": nanoid(),
          },
        });
      } catch (error) {
        console.log(error);
      }
    }

    const records = attachments?.map(async (attachment) => {
      // NOTE: Invoices can have the same name so we need to
      // ensure with a unique name
      const name = attachment.Name;

      // Just take the first part
      const [fileName] = name.split(".");

      const parts = name.split(".");
      const fileType = parts.pop();

      const uniqueFileName = stripSpecialCharacters(
        `${fileName}-${nanoid(3)}.${fileType}`
      );

      try {
        const { data, error } = await supabase.storage
          .from("vault")
          .upload(
            `${teamData.id}/inbox/${uniqueFileName}`,
            decode(attachment.Content),
            { contentType }
          );

        if (error) {
          console.log("Upload error", error);
        }

        return {
          email: res.FromFull.Email,
          name: res.FromFull.Name,
          subject,
          team_id: teamData.id,
          file_path: data.path.split("/"),
          file_name: uniqueFileName,
          content_type: contentType,
          size: attachment.ContentLength,
        };
      } catch (error) {
        console.log(error);
      }
    });

    if (records.length > 0) {
      const insertData = await Promise.all(records);

      const { data: inboxData, error } = await supabase
        .from("decrypted_inbox")
        .insert(insertData)
        .select("*, name:decrypted_name, subject:decrypted_subject");

      if (error) {
        console.log("inbox error", error);
      }

      await Promise.all(
        inboxData?.map((inbox) =>
          client.sendEvent({
            name: Events.PROCESS_DOCUMENT,
            payload: {
              inboxId: inbox.id,
            },
          })
        )
      );

      const { data: usersData } = await supabase
        .from("users_on_team")
        .select("team_id, user:users(id, full_name, avatar_url, email, locale)")
        .eq("team_id", teamData.id);

      try {
        const notificationEvents = await Promise.all(
          usersData?.map(async ({ user, team_id }) => {
            return inboxData?.map((inbox) => ({
              name: TriggerEvents.InboxNewInApp,
              payload: {
                recordId: inbox.id,
                description: `${inbox.name} - ${inbox.subject}`,
                type: NotificationTypes.Inbox,
              },
              user: {
                subscriberId: user.id,
                teamId: team_id,
                email: user.email,
                fullName: user.full_name,
                avatarUrl: user.avatar_url,
              },
            }));
          })
        );

        triggerBulk(notificationEvents?.flat());
      } catch (error) {
        console.log(error);
      }

      // NOTE: If we end up here the email was forwarded
      try {
        await supabase.from("inbox").upsert(
          inboxData?.map((inbox) => ({
            id: inbox.id,
            forwarded_to: teamData.inbox_email,
          }))
        );
      } catch (error) {
        console.log(error);
      }
    }
  }

  return Response.json({ success: true });
}
