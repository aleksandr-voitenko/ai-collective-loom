import { useState, useRef, useEffect } from "react";
import { identityGeneration, type Intent, commandRequest, isDefinitiveRejection } from "./participation-client.js";
import { type Context, useIntent, useQuery } from "./participation-state.js";
import { Collection, ErrorText } from "./participation-ui.js";

export function Editors({ id, context, kind }: { id: string; context: Context; kind:'artifact'|'summary' }) {
  const slot=kind+'.editors:'+id,path=kind==='summary'?'/api/v1/summaries/editors':'/api/v1/editors';
  const [record,update]=useIntent(()=>context.store.all().find(r=>r.slot===slot));
  const { data, error, refresh } = useQuery<{
    version: number;
    can_manage: boolean;
    editors: { id: string; nickname: string; kind: string }[];
  }>("/api/v1/resources/" + id + "/editors");
  const [editing, setEditing] = useState(!!record),
    [selected, setSelected] = useState<string[]>((record?.body.participant_ids as string[]|undefined)??[]),
    [failure, setFailure] = useState(""),[busy,setBusy]=useState(false);
  const live=useRef(false),owner=useRef(identityGeneration());
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  const current=()=>live.current&&owner.current===identityGeneration();
  async function save() {
    if(busy)return;setBusy(true);setFailure('');let sent:Intent|undefined,uncertain=false;
    try {
      sent=await update(existing=>{uncertain=existing?.state==='uncertain';const body={resource_id:id,expected_version:data!.version,participant_ids:selected};
        return context.store.prepareDispatch(existing??context.store.create(slot,kind+'.editors',path,body),body);});
      if(!sent)return;
      await commandRequest(path,{self:context.self,body:sent.body});
      await update(async existing=>{await context.store.complete(sent!);return existing?.key===sent!.key?undefined:existing;});
      if(current()){setEditing(false);refresh();}
    } catch (error) {
      if(sent&&isDefinitiveRejection(error,uncertain))try{await update(()=>context.store.settle(sent!,{state:'rejected'}));}
      catch(storageError){if(current())setFailure((storageError as Error).message);return;}
      if(current())setFailure((error as Error).message);
    }finally{if(current())setBusy(false);}
  }
  return (
    <details className="section">
      <summary>Editors</summary>
      <ErrorText error={error || failure} />
      {data && (
        <>
          <p>
            {data.editors.map((p) => p.nickname).join(", ") ||
              "No assigned editors"}
          </p>
          {data.can_manage && (
            <button
              disabled={busy||!!record}
              onClick={() => {
                setSelected(data.editors.map((p) => p.id));
                setEditing((value) => !value);
              }}
            >
              Manage editors
            </button>
          )}
          {editing && (
            <>
              <Collection
                path="/api/v1/participants"
                render={(item) => {
                  const p = item as { id: string; nickname: string };
                  return (
                    <label className="list-row">
                      <input
                        type="checkbox"
                        disabled={busy||!!record}
                        checked={selected.includes(p.id)}
                        onChange={(event) =>
                          setSelected((value) =>
                            event.target.checked
                              ? [...value, p.id]
                              : value.filter((id) => id !== p.id),
                          )
                        }
                      />
                      {p.nickname}
                    </label>
                  );
                }}
              />
              {record?.state==='rejected'?<button onClick={()=>void update(async existing=>{await context.store.remove(existing!);refresh();return undefined;}).catch(e=>setFailure(e.message))}>Dismiss rejected editor request</button>
                :<button disabled={busy} onClick={() => void save()}>{record?.state==='uncertain'?'Retry same editor change':'Save editor list'}</button>}
            </>
          )}
        </>
      )}
    </details>
  );
}
