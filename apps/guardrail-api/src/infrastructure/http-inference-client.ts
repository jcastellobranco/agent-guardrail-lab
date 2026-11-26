import { InferenceResponseSchema, type InferenceRequest, type InferenceResponse } from '@lab/contracts';
import type { InferenceClient } from '../application/ports.js';
import { InferenceFailure } from '../application/evaluate-probes.js';

export class HttpInferenceClient implements InferenceClient {
  private readonly endpoint: URL;
  constructor(baseUrl: string, private readonly transport:typeof fetch=fetch) {
    this.endpoint=new URL('/v1/score',baseUrl);
  }
  async score(request:InferenceRequest,signal:AbortSignal):Promise<InferenceResponse> {
    const response=await this.transport(this.endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request),signal,redirect:'error'});
    if(!response.ok || !response.body) {
      await response.body?.cancel();
      throw new InferenceFailure(response.status===422?'INFERENCE_REJECTED':response.status===503?'INFERENCE_BUSY_OR_UNAVAILABLE':'INFERENCE_UNAVAILABLE');
    }
    const reader=response.body.getReader();
    const chunks:Uint8Array[]=[];
    let size=0;
    try {
      for (;;) {
        const {done,value}=await reader.read();
        if(done) break;
        size+=value.byteLength;
        if(size>16384) {await reader.cancel();throw new InferenceFailure('INFERENCE_INVALID_RESPONSE');}
        chunks.push(value);
      }
      const parsed=InferenceResponseSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if(!parsed.success) throw new InferenceFailure('INFERENCE_INVALID_RESPONSE');
      return parsed.data;
    } catch(error) {
      if(error instanceof SyntaxError) throw new InferenceFailure('INFERENCE_INVALID_RESPONSE');
      throw error;
    } finally {reader.releaseLock();}
  }
}
