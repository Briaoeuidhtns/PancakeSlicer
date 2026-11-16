import type { Config, ConfigValue, PresetType } from '../api/types';
import { getState, markStale, resolvePreset, setState, type State } from '../state/store';
import { librarySync } from '../flow/library-sync';
import type { SettingMove } from '../flow/profile-save';
import { plateLabel, plateSetup } from './plate-setup';
import { MAX_FLUSH_VOLUME } from '../flush-state';
import { slotFilaments } from './slots';
import { createMachine, type Machine } from '../flow/fsm';
import { encodeLibraryWrite, putLibrary, readLibrary } from '../persist/profile-library';
import { holdReloadWhile } from '../build-update';
import { draftChanges, rebasedProfileDraft, removedInUseDrafts } from './shared-draft';
import { valueBelow } from './view';
import { profileSaveFor } from '../flow/profile-save';
import type { ProfileDraft } from './ProfileEditor';
import { configureLibraryWrites, knowLibrary, libraryWritesPending, LibraryWriteError, submitLibraryWrite,
  type EntityKey, type LibraryChange, type LibraryWriteIntent } from './library-writes';
import { getRecord, recordKey, sameRecord, setRecord, type AnyRecord, type FilamentRecord, type LibraryRecords, type PrinterRecord, type ProcessRecord, type RecordKind } from './records';
import { randomId } from '../random-id';

const conflict=(message:string)=>new LibraryWriteError(message,'revision_conflict');
const kindOf=(type:PresetType):RecordKind=>type==='machine'?'printer':type==='filament'?'filament':'process';

configureLibraryWrites({read:readLibrary,encode:encodeLibraryWrite,put:putLibrary,adopt:adoptLibrary,loading:()=>getState().profileLibraryLoad.state==='loading'});
holdReloadWhile(libraryWritesPending);

let adopting=false;
function settingChanges(a:AnyRecord|undefined,b:AnyRecord|undefined):[string,ConfigValue|undefined,ConfigValue|undefined][]{
  const out:[string,ConfigValue|undefined,ConfigValue|undefined][]=[];
  for(const field of ['settings','values','machine','printOverrides']){
    const x=((a as unknown as Record<string,Config|undefined>|undefined)?.[field])??{},y=((b as unknown as Record<string,Config|undefined>|undefined)?.[field])??{};
    for(const k of new Set([...Object.keys(x),...Object.keys(y)]))if(JSON.stringify(x[k])!==JSON.stringify(y[k]))out.push([k,x[k],y[k]]);
  }
  return out;
}
function printerMoves(s:State,library:LibraryRecords,a:PrinterRecord|undefined,b:PrinterRecord|undefined):SettingMove[]{
  if(!a || !b)return [];
  const out:SettingMove[]=[];
  if(a.plate!==b.plate){const setup=plateSetup(s,b.id),plate=(v:string|undefined)=>plateLabel(setup,v ?? setup?.default) || 'the default plate';
    out.push({label:'Build plate',from:plate(a.plate),to:plate(b.plate)});}
  const n=Math.max(1,b.slots.length),va=a.flushing?.volumes ?? [],vb=b.flushing?.volumes ?? [],one=Math.max(va.length,vb.length)>n*n;
  const nozzles=plateSetup(s,b.id)?.flushing?.nozzles ?? [];
  const volume=(v:(number|null)[],m:number[]|undefined,i:number,cell:number,nozzle:number)=>{
    const raw=v[i] ?? nozzles[nozzle]?.auto[cell];
    return raw===undefined || raw===null ? 'auto' : String(Math.round(Math.min(MAX_FLUSH_VOLUME,raw*(m?.[nozzle] ?? nozzles[nozzle]?.multiplier ?? 1))));
  };
  for(let i=0;i<Math.max(va.length,vb.length);i++)if((va[i] ?? null)!==(vb[i] ?? null)){
    const cell=i%(n*n),nozzle=Math.floor(i/(n*n)),from=Math.floor(cell/n)+1,to=cell%n+1;
    out.push({label:`Flushing volumes${one?` (nozzle ${nozzle+1})`:''}: slot ${from} → ${to},`,from:volume(va,a.flushing?.multipliers,i,cell,nozzle),to:volume(vb,b.flushing?.multipliers,i,cell,nozzle)});
  }
  const filamentName=(id:string|undefined)=>!id ? 'empty' : s.records.filaments.find((f)=>f.id===id || f.aliases?.includes(id))?.name ?? 'a removed filament';
  for(let i=0;i<Math.max(a.slots.length,b.slots.length);i++){
    const x=a.slots[i],y=b.slots[i];
    const removed=!!x?.filament && !library.filaments.some((f)=>(f.id===x.filament || f.aliases?.includes(x.filament)) && !f.archived);
    if((x?.filament ?? '')!==(y?.filament ?? '') && !removed)out.push({label:`Slot ${i+1}`,from:filamentName(x?.filament),to:filamentName(y?.filament)});
    if((x?.colour ?? '')!==(y?.colour ?? ''))out.push({label:`Slot ${i+1} colour`,from:x?.colour || 'none',to:y?.colour || 'none'});
  }
  const ma=a.flushing?.multipliers ?? [],mb=b.flushing?.multipliers ?? [];
  for(let i=0;i<Math.max(ma.length,mb.length);i++)if(ma[i]!==mb[i])out.push({label:`Flushing multiplier${Math.max(ma.length,mb.length)>1?` (nozzle ${i+1})`:''}`,from:String(ma[i] ?? 1),to:String(mb[i] ?? 1)});
  return out;
}
export function acknowledgePendingProfileWrite():Promise<void>{
  return serialize(async()=>{if(pending)await acknowledge(pending);});
}
function adoptLibrary(doc:LibraryRecords,published:LibraryWriteIntent[],written:Set<EntityKey>,pending:LibraryWriteIntent[]){
  if(doc.revision<getState().profileLibraryRevision && doc.epoch===getState().records.epoch){
    if(published.some(i=>i.publish))setState(s=>{let patch:Partial<State>={};for(const intent of published)if(intent.publish)patch={...patch,...intent.publish({...s,...patch},doc)};return patch;});
    return;
  }
  const before=getState(),library=working(doc,pending),remote:string[]=[];
  const own=new Set<EntityKey>([...written,...[...published,...pending].flatMap(i=>[...i.change?.next.keys() ?? []])]);
  for(const [type,list] of [['machine',library.printers],['filament',library.filaments],['process',library.processes]] as [PresetType,{id:string;revision:number}[]][])
    for(const r of list){const key=recordKey(kindOf(type),r.id),old=getRecord(before.records,key);if(old && !own.has(key) && !sameRecord(old,r as AnyRecord))remote.push(JSON.stringify([type,r.id]));}
  if(remote.length)void Promise.all([import('./format'),import('../options'),import('../state/value-equality')]).then(([{display},{OPTIONS},{sameValue}])=>{
    const conflicted:[string,import('../flow/profile-save').SettingMove[]][]=[],updated:[string,import('../flow/profile-save').SettingMove[]][]=[],rebased:Record<string,ProfileDraft>={};
    for(const k of remote){
      const [type,id]=JSON.parse(k) as [PresetType,string],rk=recordKey(kindOf(type),id),now=getRecord(library,rk);
      if((now as {archived?:unknown}|undefined)?.archived)continue;
      const diff=settingChanges(getRecord(before.records,rk),now),mine=draftChanges(before,type,id);
      const clash=diff.filter(([key,,b])=>key in mine && !sameValue(key,mine[key],b));
      if(clash.length){conflicted.push([k,clash.map(([key,,b])=>({label:OPTIONS[key]?.label||key,from:display(key,mine[key]),to:display(key,b)}))]);continue;}
      const draft=before.libraryDrafts[k];
      if(draft){const baseline={...draft.baseline};for(const [key,,b] of diff)if(b===undefined)delete baseline[key];else baseline[key]=b;
        rebased[k]=rebasedProfileDraft(draft,now as ProfileDraft['origin'],baseline);}
      const layers=resolvePreset(before,type,id).layers;
      const shown=(key:string,stored:ConfigValue|undefined)=>display(key,mine[key]??stored??valueBelow(layers[key],'record'));
      const told=[...diff.map(([key,a,b])=>({label:OPTIONS[key]?.label||key,from:shown(key,a),to:shown(key,b)})),
        ...(type==='machine'?printerMoves(before,library,getRecord(before.records,rk) as PrinterRecord|undefined,now as PrinterRecord|undefined):[])].filter(m=>m.from!==m.to);
      if(told.length)updated.push([k,told]);
    }
    if(Object.keys(rebased).length)setState(st=>({libraryDrafts:{...st.libraryDrafts,...Object.fromEntries(Object.entries(rebased).filter(([k])=>st.libraryDrafts[k]===before.libraryDrafts[k]))}}));
    if(conflicted.length)librarySync.send({type:'CONFLICT_ELSEWHERE',conflicts:conflicted});
    if(updated.length)librarySync.send({type:'RECORD_CHANGED_ELSEWHERE',moves:updated});});
  adopting=true;
  try{
    setState(s=>{
      let patch:Partial<State>={records:library,profileLibraryRevision:doc.revision,job:markStale(s.job),...removedInUseDrafts(s,library,(type,id)=>written.has(recordKey(kindOf(type),id)))};
      for(const [type,list] of [['machine',s.records.printers],['filament',s.records.filaments],['process',s.records.processes]] as [PresetType,{id:string;archived?:unknown}[]][])for(const r of list){
        const id=r.id,rk=recordKey(kindOf(type),id),k=JSON.stringify([type,id]);
        if(r.archived || written.has(rk) || !(getRecord(library,rk) as {archived?:unknown}|undefined)?.archived || (patch.libraryDrafts ?? s.libraryDrafts)[k] || profileSaveFor(k).get().value!=='naming')continue;
        const config=resolvePreset(s,type,id).config;
        patch={...patch,libraryDrafts:{...(patch.libraryDrafts ?? s.libraryDrafts),[k]:{values:config,baseline:config,origin:getRecord(s.records,rk) as ProfileDraft['origin'],printer:s.printer}}};}
      for(const intent of published)if(intent.publish)patch={...patch,...intent.publish({...s,...patch},doc)};
      return patch;
    });
  }finally{adopting=false;}
  const after=getState(),told:string[]=[];
  const name=(type:PresetType,id:string)=>(getRecord(before.records,recordKey(kindOf(type),id)) as {name?:string}|undefined)?.name ?? 'A profile';
  const gone=(type:PresetType,id:string)=>!!id && !written.has(recordKey(kindOf(type),id)) && !(getRecord(before.records,recordKey(kindOf(type),id)) as {archived?:unknown}|undefined)?.archived
    && (!getRecord(library,recordKey(kindOf(type),id)) || !!(getRecord(library,recordKey(kindOf(type),id)) as {archived?:unknown}).archived);
  const now=(type:PresetType,id:string)=>id ? (getRecord(after.records,recordKey(kindOf(type),id)) as {name?:string}|undefined)?.name : undefined;
  if(gone('machine',before.printer))told.push(`${name('machine',before.printer)} was removed in another window; choose a printer.`);
  if(gone('process',before.process))told.push(`${name('process',before.process)} was removed in another window; ${now('process',after.process) ? `${now('process',after.process)} is used now` : 'choose a print profile'}.`);
  const was=slotFilaments(before),is=slotFilaments(after);
  was.forEach((id,i)=>{if(gone('filament',id))told.push(`${name('filament',id)} was removed in another window; slot ${i+1} ${now('filament',is[i]) ? `now uses ${now('filament',is[i])}` : 'is empty'}.`);});
  if(told.length)librarySync.send({type:'IN_USE_REMOVED_ELSEWHERE',lines:told});
}
export function profileCreation(factory:(s:State)=>UserPreset|string):ProfileCreation{
  const batch=profileBatchCreation(s=>{const created=factory(s);return typeof created==='string' ? {records:[],reused:[created]} : {records:[created]};});
  return {get retryable(){return batch.retryable;},commit:()=>batch.commit().then(result=>result.keys[0])};
}

type CreationState = 'idle' | 'committing' | 'done' | 'failed';
export interface CreationResult {keys:string[]}
type CreationEvent = { type: 'COMMIT' } | { type: 'DONE'; result: CreationResult } | { type: 'FAIL'; error: string };
interface CreationContext { result: CreationResult | null; error: string | null; flight: Promise<CreationResult> | null }
export type CreationMachine = Machine<CreationState, CreationEvent, CreationContext>;
export interface ProfileCreation {readonly machine:CreationMachine;commit():Promise<string>}
export const creationPending=(c:{machine:CreationMachine})=>c.machine.get().value==='committing';
function creationMachine(write:()=>Promise<CreationResult>):CreationMachine{
  const start={target:'committing' as const,action:()=>{
    const flight=write();
    flight.then(result=>machine.send({type:'DONE',result}),error=>machine.send({type:'FAIL',error:error instanceof Error?error.message:String(error)}));
    return {flight,error:null};
  }};
  const machine:CreationMachine=createMachine<CreationState,CreationEvent,CreationContext>({id:'profile-creation',initial:'idle',strict:true,context:{result:null,error:null,flight:null},states:{
    idle:{on:{COMMIT:start}},
    committing:{on:{COMMIT:{},DONE:{target:'done',action:(_,e)=>({result:e.result,flight:null})},FAIL:{target:'failed',action:(_,e)=>({error:e.error,flight:null})}}},
    done:{on:{COMMIT:{}}},
    failed:{on:{COMMIT:start}},
  }});
  return machine;
}
async function performSave(s:State,records:UserPreset[],operationId?:string,printers?:PrinterProfileLibrary,catalog?:SystemPreset[],setup?:PrinterSetupSaveContext):Promise<Acknowledgement>{
  ready(s);ready(getState());
  const requestSignature=signature(records,printers,catalog),outstanding=pending;
  const priorAck=outstanding?await acknowledge(outstanding):undefined;
  if(priorAck && outstanding!.signature===requestSignature){
    if(priorAck.changed.size || priorAck.setupsChanged){publishAcknowledgement(priorAck);throw conflict('This profile or printer setup was updated in another window right after you saved. We kept your draft so you can compare them.');}
    return priorAck;
  }
  if(priorAck)publishAcknowledgement(priorAck);
  const current=()=>{if(setup && !setup.isCurrent())throw Object.assign(new Error('Your printer setup changed in the meantime—we kept your newest setup.'),{code:'setup_context_changed'});};
  current();
  const remote=priorAck?.document ?? await readProfileLibrary(s.api?.mock);
  current();
  ready(getState());if(getState().api!==s.api)throw new Error('The profile library updated while saving. Don\'t worry, your draft edits are still here!');
  const profiles=new Map(remote.profiles.map(p=>[p.id,p]));
  if(profiles.size!==remote.profiles.length || remote.profiles.some(p=>!p.id))throw conflict('Oops! Your profile library has duplicate or missing IDs that need a quick repair.');
  const submitted:UserPreset[]=[];
  for(const p of records){
    const id=profileKey(p),prior=findProfile(s,p.type,id),raw=profiles.get(id),actual=raw && normalizeUserPreset(raw);
    if(prior && !actual)throw Object.assign(new Error('This profile was deleted elsewhere, but we kept your unsaved edits right here.'),{code:'profile_missing',recovery:'reload_profiles'});
    const own=prior && ownAcknowledgements.get(prior),ownAdvance=!!actual && !!own && equal(stored(actual),stored(own));
    if(prior && actual && (actual.revision ?? 0)>(prior.revision ?? 0) && !ownAdvance)throw conflict('Heads up: this profile was updated in another window. Your current draft edits are still kept here.');
    if(prior && (p.revision ?? 0)<(prior.revision ?? 0) && !ownAdvance)throw conflict('This profile was updated elsewhere since you started editing. Your draft edits are still kept here.');
    let prepared=prepareProfile(s,p);
    if(actual && equal({...stored(prepared),revision:0},{...stored(actual),revision:0})){submitted.push(actual);continue;}
    if(actual)prepared={...prepared,revision:Math.max(prepared.revision ?? 0,(actual.revision ?? 0)+1)};
    profiles.set(id,storedProfile(prepared));submitted.push(prepared);
  }
  if(printers && (setup ? !sameSetups(remote.printers,ownSetupAcknowledgements.get(setup.baseline) ?? setup.baseline)
    : !sameSetups(remote.printers,s.printerLibrary) && !(priorAck && sameSetups(remote.printers,priorAck.request.write.document.printers))))throw conflict('The saved printer setups changed. Reload before replacing them; your working setup is kept.');
  const catalogKeys=new Set(catalog?.map(catalogKey));
  const document={...remote,profiles:[...profiles.values()],...(catalog?.length?{catalog:[...(remote.catalog ?? []).filter(p=>!catalogKeys.has(catalogKey(p))),...catalog]}:{}),printers:printers ?? remote.printers ?? s.printerLibrary ?? emptyPrinterLibrary()};
  if(equal(document,remote))return {request:freezeWrite(s,{operationId:operationId ?? '',expectedRevision:remote.revision,document},submitted,requestSignature),document:remote,records:submitted,changed:new Set()};
  const request=freezeWrite(s,{operationId:operationId ?? `save:${randomId()}`,expectedRevision:remote.revision,document},submitted,requestSignature,printers ? setup?.baseline ?? s.printerLibrary : undefined);
  const ack=await acknowledge(request);
  if(ack.changed.size || ack.setupsChanged){publishAcknowledgement(ack);throw conflict('This profile or printer setup changed in another window. We kept your draft so you can compare them.');}
  return ack;
}
export function saveProfileRecords(s:State,records:UserPreset[],operationId?:string,printers?:PrinterProfileLibrary,catalog?:SystemPreset[],setup?:PrinterSetupSaveContext):Promise<void>{
  return serialize(async()=>{const ack=await performSave(s,records,operationId,printers,catalog,setup);publishAcknowledgement(ack);});
}

type NamedKind = 'printer' | 'filament' | 'process';
type Named = PrinterRecord | FilamentRecord | ProcessRecord;
const listOf = (doc: LibraryRecords, kind: NamedKind) => (kind === 'printer' ? doc.printers : kind === 'filament' ? doc.filaments : doc.processes) as Named[];
export function recordCopy<R extends AnyRecord>(kind:RecordKind,record:R,id:string,name:string):R{
  const {archived:_a,...rest}=record as R&{archived?:unknown};
  const copy={...rest,id,name,revision:0} as unknown as R;
  if(kind==='printer'){const p=copy as unknown as PrinterRecord;p.slots=p.slots.map(slot=>({...slot,id:`slot:${randomId()}`}));}
  if(kind==='filament')delete (copy as unknown as FilamentRecord).aliases;
  return copy;
}
const masterCreations=new Map<string,ProfileCreation>();
export async function ensureEditableMaster(type:PresetType,baseKey:string):Promise<string>{
  const s=getState(),existing=findProfile(s,type,baseKey);
  if(existing?.kind==='master' && profileKey(existing)===baseKey)return profileKey(existing);
  const base=findCatalogBase(s,type,baseKey).base;
  if(!base)throw new Error('Pick the exact catalog template before editing its base profile.');
  const token=catalogKey(base);
  let creation=masterCreations.get(token);
  if(!creation){
    creation=profileCreation(latest=>{
      const master=editableMaster(latest,type,token);
      return findProfile(latest,type,profileKey(master)) ? profileKey(master) : master;
    });
    masterCreations.set(token,creation);
  }
  try{
    const key=await creation.commit();
    if(masterCreations.get(token)===creation)masterCreations.delete(token);
    return key;
  }catch(error){
    if(!creation.retryable && masterCreations.get(token)===creation)masterCreations.delete(token);
    throw error;
  }
}
export interface ProfileArchiveUndo {type:PresetType;keys:string[];operationId:string}
export async function archiveProfiles(type:PresetType,keys:readonly string[]):Promise<ProfileArchiveUndo>{
  const s=getState(),operationId=`archive:${randomId()}`,records=keys.map(key=>archiveProfile(s,type,key,operationId));
  await commitProfileRecords(records,{operationId});return{type,keys:records.map(profileKey),operationId};
}
export async function restoreProfiles(undo:ProfileArchiveUndo):Promise<void>{
  const s=getState(),records=undo.keys.flatMap(key=>{const p=findProfile(s,undo.type,key);return p?.archived?.operationId===undo.operationId?[restoreArchivedProfile(p)]:[];});
  if(records.length)await commitProfileRecords(records);
}
