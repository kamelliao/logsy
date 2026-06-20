import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import logo from "@/assets/logo.png";
import { APP_NAME, APP_AUTHOR } from "@/config";

interface AboutModalProps {
  version: string;
  onClose: () => void;
}

export function AboutModal({ version, onClose }: AboutModalProps) {
  return (
    <div className="about-overlay" onMouseDown={onClose}>
      <div className="about-box" onMouseDown={(e) => e.stopPropagation()}>
        <Button
          variant="ghost"
          size="icon"
          className="about-x"
          onClick={onClose}
        >
          <X size={18} />
        </Button>
        <div className="about-head">
          <img className="about-logo" src={logo} alt={APP_NAME} />
          <div>
            <div className="about-name">{APP_NAME}</div>
            <div className="about-ver">Version {version}</div>
          </div>
        </div>
        <div className="about-copy-container">
          <div className="about-copy">
            Copyright © {new Date().getFullYear()} {APP_AUTHOR}
          </div>
          <div className="about-copy">Licensed under GPLv3.</div>
        </div>
      </div>
    </div>
  );
}
