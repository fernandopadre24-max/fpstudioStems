import type { Backend, StemModelId } from "./constants";
import type { WorkerRequest, WorkerResponse } from "./protocol";

type Listener = (message: WorkerResponse) => void;

export class SeparationEngine {
  private worker: Worker;
  private listeners = new Set<Listener>();

  constructor() {
    this.worker = new Worker(new URL("../separation.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      for (const listener of this.listeners) listener(event.data);
    };
    this.worker.onerror = (event) => {
      const message = event.message || "Erro inesperado no processo de separacao.";
      this.emit({ type: "error", message });
    };
    this.worker.onmessageerror = () => {
      this.emit({ type: "error", message: "Falha de comunicacao com o processo de separacao." });
    };
  }

  private emit(message: WorkerResponse) {
    for (const listener of this.listeners) listener(message);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private send(message: WorkerRequest) {
    this.worker.postMessage(message);
  }

  checkModel(model: StemModelId) {
    this.send({ type: "check-model", model });
  }

  setBlockWebgpu(block: boolean) {
    this.send({ type: "prefs", blockWebgpu: block });
  }

  separate(
    left: Float32Array,
    right: Float32Array,
    backend: Backend,
    model: StemModelId,
    splitPercussion = false,
  ) {
    this.send({ type: "separate", left, right, backend, model, splitPercussion });
  }

  cancel() {
    this.send({ type: "cancel" });
  }

  dispose() {
    this.listeners.clear();
    this.worker.terminate();
  }
}
