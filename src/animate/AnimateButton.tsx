// The status bar's Animate button (new in 2.1, ROADMAP Phase E): beside the zoom and the counts,
// where a teacher looks for "play". Pressed while the tab's canvas is in animation mode.
import { Play } from "lucide-react";
import { Icon } from "../components/Icon";
import { toggleAnimate, useAnimateOn } from "./store";
import { animateWords as w } from "./words";
import "./animate.css";

export function AnimateButton({ tabId }: { tabId: string }) {
  const on = useAnimateOn(tabId);
  return (
    <>
      <span className="canvas-sb-div" aria-hidden="true" />
      <button type="button" className="animate-sb-button" aria-pressed={on} title={on ? w.buttonHelpOn : w.buttonHelp} onClick={() => toggleAnimate(tabId)}>
        <Icon icon={Play} size={12} aria-hidden="true" />
        <span>{on ? w.buttonOn : w.button}</span>
      </button>
    </>
  );
}
