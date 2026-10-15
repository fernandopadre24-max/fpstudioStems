import { SessionManager, YoutubeSessionDataCaches } from "./session_manager.ts";

export default async function initSession() {
    const sessionManager = new SessionManager(false, {} as YoutubeSessionDataCaches);
    return { sessionManager };
}
