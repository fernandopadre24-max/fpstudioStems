// Mensagens de erro que o usuario consegue entender.
//
// "Failed to fetch" e o texto cru do navegador quando a requisicao nem chega ao
// servidor (app local fechado, tunel reiniciado, rede caiu). Sem traducao isso
// vira um beco sem saida para quem esta usando.

const NETWORK = /failed to fetch|networkerror|network error|load failed|fetch failed|network request failed|err_network|err_connection|err_internet/i;

export function friendlyError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (NETWORK.test(message)) {
    return (
      "Nao consegui falar com o servidor do app: a conexao caiu antes da resposta " +
      "(o servidor pode ter demorado demais). Tente de novo. " +
      "Se voce esta no modo local/tunel, confira se a janela do abrir-app continua aberta: " +
      "quando o tunel reinicia, a URL muda."
    );
  }
  return message;
}

/** O erro eh de rede (nao adianta repetir com outro video/arquivo)? */
export function isNetworkError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return NETWORK.test(message);
}
