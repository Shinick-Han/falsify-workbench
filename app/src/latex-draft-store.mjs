import {LAYOUT_RUN_TTL_MS} from './paper-layout-run-store.mjs';

// The user's opt-in source draft includes the layout result. Large archives stay
// out of localStorage; that key contains only a timestamp/migration marker.
export function createLatexDraftStore({indexedDB=globalThis.indexedDB,now=Date.now}={}){
  let opening=null,memory=null,epoch=0;
  const fresh=row=>row?.consent===true&&Number.isFinite(row.savedAt)&&row.savedAt<=now()&&now()-row.savedAt<LAYOUT_RUN_TTL_MS;
  const open=()=>opening??=(new Promise((resolve,reject)=>{
    if(!indexedDB){reject(new Error('기기 저장을 사용할 수 없습니다.'));return;}
    const req=indexedDB.open('falsify-latex-drafts',1);
    req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('drafts'))req.result.createObjectStore('drafts');};
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error||new Error('기기 저장을 열지 못했습니다.'));
  })).catch(error=>{opening=null;throw error;});
  async function transaction(mode,operation){const db=await open();return new Promise((resolve,reject)=>{const tx=db.transaction('drafts',mode);let value;const req=operation(tx.objectStore('drafts'));req.onsuccess=()=>{value=req.result;};tx.oncomplete=()=>resolve(value);tx.onabort=tx.onerror=()=>reject(tx.error||req.error||new Error('기기 저장을 마치지 못했습니다.'));});}
  return {
    async put(archive,{consent=false}={}){
      if(consent!==true)return {persisted:false};
      if(typeof archive!=='string')throw new TypeError('Source archive text required');
      const at=epoch,row={archive,consent:true,savedAt:now()};memory=row;
      try{await transaction('readwrite',store=>store.put(row,'current'));if(at!==epoch){await transaction('readwrite',store=>store.delete('current'));return {persisted:false};}return {persisted:true,savedAt:row.savedAt};}
      catch(error){return {persisted:false,savedAt:row.savedAt,storageError:error.message};}
    },
    async get(){
      if(memory&&fresh(memory))return memory;
      memory=null;let row;try{row=await transaction('readonly',store=>store.get('current'));}catch{return null;}
      if(fresh(row))return row;
      if(row)try{await transaction('readwrite',store=>store.delete('current'));}catch{}
      return null;
    },
    async clear(){memory=null;epoch++;try{await transaction('readwrite',store=>store.delete('current'));return {cleared:true};}catch(error){return {cleared:false,storageError:error.message};}},
    dispose(){memory=null;opening?.then(db=>db.close(),()=>{});opening=null;epoch++;}
  };
}
