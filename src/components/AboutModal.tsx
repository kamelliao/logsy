import { X } from "lucide-react";
import { Button } from "./ui/button";

interface AboutModalProps {
  version: string;
  onClose: () => void;
}

const AUTHOR = "Kamel Liao";

export function AboutModal({ version, onClose }: AboutModalProps) {
  return (
    <div className="about-overlay" onMouseDown={onClose}>
      <div className="about-box" onMouseDown={(e) => e.stopPropagation()}>
        <Button variant="ghost" size="icon" className="about-x" onClick={onClose}>
          <X size={18} />
        </Button>
        <div className="about-head">
          <span className="about-logo" />
          <div>
            <div className="about-name">logsy</div>
            <div className="about-ver">Version {version}</div>
          </div>
        </div>
        <div className="about-copy-container">
          <div className="about-copy">Copyright © {new Date().getFullYear()} {AUTHOR}</div>
          <div className="about-copy">Licensed under GPLv3.</div>
        </div>
      </div>
    </div>
  );
}
