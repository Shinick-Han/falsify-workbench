import {inspectLayoutDocument,getLayoutBlock,compareLayoutDocuments} from './paper-layout-document-tools.mjs';
import {updateBlockLayout,inspectProjectFonts,setProjectTypography} from './paper-layout-edit-tools.mjs';
import {readLayoutTable,rebuildLayoutTable,getLayoutFigure,placeLayoutFigure,replaceLayoutFigure} from './paper-layout-asset-tools.mjs';

export function createLayoutToolHandlers({referenceBytes,renderRegion,allowedReplacements=[]}={}){
 const shared=()=>({...((referenceBytes instanceof Uint8Array)?{referenceBytes:referenceBytes.slice()}:{}),allowedReplacements:[...allowedReplacements]});
 const read=fn=>async input=>({observation:await fn({...input,...shared()})});
 const edit=fn=>async input=>fn({...input,...shared()});
 return {
  inspect_document:read(inspectLayoutDocument),get_block:read(getLayoutBlock),compare_document:read(compareLayoutDocuments),
  update_layout:edit(updateBlockLayout),inspect_fonts:read(inspectProjectFonts),set_typography:edit(setProjectTypography),
  read_table:read(readLayoutTable),rebuild_table:edit(rebuildLayoutTable),
  get_figure:async input=>({observation:{...await getLayoutFigure({...input,...shared()}),replacementImages:[...allowedReplacements]}}),
  place_figure:edit(placeLayoutFigure),replace_figure:edit(replaceLayoutFigure),
  ...(typeof renderRegion==='function'?{render_region:renderRegion}:{})
 };
}
