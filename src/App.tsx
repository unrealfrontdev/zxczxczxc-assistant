import { useTauriEvents } from "./hooks/useTauriEvents";
import AssistantPanel from "./components/AssistantPanel";

export default function App() {
  useTauriEvents();
  return <AssistantPanel />;
}
