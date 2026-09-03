import { Button } from "../ui/button";
import { CopyCheck, useCopy } from "../ui/copy";
import { Disclosure } from "../ui/disclosure";
import { PRODUCT_NAME, PUBLIC_BASE_URL, WEBHOOK_BASE_URL } from "../lib/brand";
import { slackCreateAppUrl, slackManifestJson } from "../lib/slack-manifest";
import type { SlackTransport } from "../lib/slack-setup";
import { IconCopy } from "./icons";

/**
 * Creates the Slack app from generated configuration instead of asking the
 * person to transcribe scopes, subscriptions, and request URLs. The transport
 * comes from the dialog's credential choice so the manifest and form agree.
 */
export function SlackManifestGuide({
  transport,
}: {
  transport: SlackTransport;
}) {
  const options = {
    publicBaseUrl: PUBLIC_BASE_URL,
    webhookBaseUrl: WEBHOOK_BASE_URL,
    transport,
    appName: PRODUCT_NAME,
  };
  const json = slackManifestJson(options);
  const { copied, copy } = useCopy();

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          render={
            <a
              href={slackCreateAppUrl(options)}
              target="_blank"
              rel="noreferrer"
            />
          }
        >
          Create Slack app
        </Button>
        <Button
          size="sm"
          onClick={() => copy(json, { toast: "Manifest copied" })}
        >
          <CopyCheck copied={copied} size={14} idle={<IconCopy size={14} />} />
          {copied ? "Copied" : "Copy manifest"}
        </Button>
      </div>

      <p className="m-0 text-supporting leading-relaxed text-dim">
        The manifest fills in the scopes, event subscriptions
        {transport === "http" ? ", request URLs" : " and Socket Mode"}, and
        interactivity. Credentials are still yours to paste above.
      </p>

      <Disclosure title="Manifest JSON" panelClassName="pt-2">
        <pre className="m-0 max-h-72 overflow-auto rounded-control bg-panel p-2.5 font-mono text-meta leading-relaxed text-dim">
          {json}
        </pre>
      </Disclosure>
    </div>
  );
}
