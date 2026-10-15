import { Callout } from "@/components/ui/Callout";
import { CONSENT_CHANGED, CONSENT_VERSIONS, consentStatement, HOSTED_MODEL_PROVIDER, namesModelProvider } from "@/lib/connectors/consent";
import type { ProviderId } from "@/lib/connectors/provider";

const LINK = "font-medium text-agent underline decoration-agent-line underline-offset-4 transition-colors duration-150 ease-standard hover:decoration-agent";

/**
 * What a person agrees to on a connect page (src/lib/connectors/consent.ts), inside its form. The version shown goes
 * with the form, so the connect route records the words the person read, and sends them back here to read them again
 * when the words changed since the page loaded. The line that names the model provider links its API terms and its
 * privacy policy, which the statement points to.
 */
export function ConnectorConsent({ provider, title, changed }: { provider: ProviderId; title: string; changed: boolean }) {
  return (
    <>
      <input type="hidden" name="consent_version" value={CONSENT_VERSIONS[provider]} />
      {changed && (
        <p role="alert" className="text-sm text-refused">
          {CONSENT_CHANGED}
        </p>
      )}
      <Callout title={title}>
        <ul className="list-disc space-y-1 pl-5">
          {consentStatement(provider).map((line) => (
            <li key={line}>
              {line}
              {namesModelProvider(line) && (
                <>
                  {" "}
                  Read {HOSTED_MODEL_PROVIDER.name}&apos;s{" "}
                  <a href={HOSTED_MODEL_PROVIDER.terms} target="_blank" rel="noopener noreferrer" className={LINK}>
                    API terms
                  </a>{" "}
                  and{" "}
                  <a href={HOSTED_MODEL_PROVIDER.privacy} target="_blank" rel="noopener noreferrer" className={LINK}>
                    privacy policy
                  </a>
                  .
                </>
              )}
            </li>
          ))}
        </ul>
      </Callout>
    </>
  );
}
