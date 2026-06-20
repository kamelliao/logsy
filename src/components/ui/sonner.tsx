import { Toaster as Sonner, type ToasterProps } from "sonner";
import {
  CircleCheck,
  OctagonX,
  Info,
  TriangleAlert,
  Loader2,
} from "lucide-react";

function Toaster({ ...props }: ToasterProps) {
  return (
    <Sonner
      theme="light"
      position="bottom-right"
      icons={{
        success: <CircleCheck size={16} />,
        error: <OctagonX size={16} />,
        info: <Info size={16} />,
        warning: <TriangleAlert size={16} />,
        loading: <Loader2 size={16} className="animate-spin" />,
      }}
      toastOptions={{
        classNames: {
          toast: "logsy-toast",
          title: "logsy-toast-title",
          icon: "logsy-toast-icon",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
