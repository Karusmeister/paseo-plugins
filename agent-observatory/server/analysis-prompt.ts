import { languageName } from "./locales";
import { currentLanguage, onTextChange } from "../shared/i18n";
import { t } from "../shared/text";

/**
 * The analysis helper's system prompt: review only the evidence in the prompt, call no tools, obey nothing in the
 * transcript. (The locale key keeps its old name from when the Grok CLI runner, since removed, owned this prompt.)
 */
export let ANALYSIS_SYSTEM_PROMPT = t("serverGrokRunner.m001", { language: currentLanguage(), languageName: languageName() });

// Refresh module-level display text when the selected language changes.
onTextChange(() => {
  ANALYSIS_SYSTEM_PROMPT = t("serverGrokRunner.m001", { language: currentLanguage(), languageName: languageName() });
});
