import type { ClientInfo } from '../wire';
import { Composer } from './Composer';
import { Connecting, Onboarding, SelectPrompt } from './EmptyState';
import { Topbar } from './Topbar';
import { Transcript } from './Transcript';

interface Props {
  routeId: string | null;
  client: ClientInfo | null;
  hasClients: boolean;
  onBack: () => void;
}

export function ChatPane({ routeId, client, hasClients, onBack }: Props) {
  let body: React.ReactNode;
  if (routeId && client) {
    body = (
      <>
        <Topbar client={client} onBack={onBack} />
        <Transcript clientId={client.clientId} />
        <Composer clientId={client.clientId} />
      </>
    );
  } else if (routeId) {
    // Deep-linked session that has not appeared in the list yet.
    body = <Connecting />;
  } else {
    body = hasClients ? <SelectPrompt /> : <Onboarding />;
  }
  return (
    <main className="chat-pane">
      <div className="chat-body">{body}</div>
    </main>
  );
}
