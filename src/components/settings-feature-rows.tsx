import { useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { assistantActsEnabled } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";
import { SettingRow, Switch } from "./SettingsPrimitives";

function FeatureToggleRow({ feature, enabled, title, subtitle, ariaLabel, fallbackError }: {
  feature: "assistantActs";
  enabled: boolean;
  title: string;
  subtitle: string;
  ariaLabel: string;
  fallbackError: string;
}) {
  const { dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { [feature]: !enabled } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallbackError);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow
      title={title}
      subtitle={subtitle}
      message={error ? <p role="alert" className="text-danger">{error}</p> : null}
    >
      <Switch
        checked={enabled}
        aria-label={ariaLabel}
        disabled={saving}
        onClick={() => void toggle()}
        className="disabled:cursor-wait disabled:opacity-50"
      />
    </SettingRow>
  );
}

export function AssistantActsRow() {
  const { state } = useStore();
  return (
    <FeatureToggleRow
      feature="assistantActs"
      enabled={assistantActsEnabled(state.config)}
      title={t("settings.assistantActs.title")}
      subtitle={t("settings.assistantActs.subtitle")}
      ariaLabel={t("settings.assistantActs.aria")}
      fallbackError={t("settings.assistantActs.error")}
    />
  );
}
