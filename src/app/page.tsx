import { labEnabled } from "@/lab/enabled";
import { HomeScreen } from "./HomeScreen";

/**
 * The front door — see `HomeScreen`. A server component only so the dev-only
 * lab link can be decided where `labEnabled` can be read.
 */
export default function Home() {
  return <HomeScreen lab={labEnabled()} />;
}
