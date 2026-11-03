"""Cumulative source-style charts and existing table editing use one PDF output."""
import base64, hashlib, sys, unittest
from pathlib import Path
from unittest.mock import patch
import pymupdf
sys.path[:0]=[str(Path(__file__).resolve().parents[1]/'local')]
from chart_shape_fixture import chart_pdf
from paper_evidence import EvidenceStore
from paper_chart_edit_service import ChartEditService, SCHEMA
from paper_visual_edit import export_visual

class ChartVisualIntegrationTests(unittest.TestCase):
    def test_two_native_regions_and_table_keep_previous_edits(self):
        doc=pymupdf.open();page=doc.new_page(width=620,height=320)
        page.insert_text((30,25),'Two independent charts')
        for left,color in [(30,(1,0,0)),(330,(0,0,1))]:
            page.draw_line((left,270),(left+240,270),color=(0,0,0))
            page.draw_line((left,270),(left,50),color=(0,0,0))
            shape=page.new_shape();shape.draw_polyline([(left+i*2.4,240-i) for i in range(101)])
            shape.finish(color=color,width=2,closePath=False);shape.commit()
        other=pymupdf.open(stream=chart_pdf(),filetype='pdf');doc.insert_pdf(other,from_page=2,to_page=2);other.close()
        raw=doc.tobytes();doc.close();digest=hashlib.sha256(raw).hexdigest()
        store=EvidenceStore();pid=store.prepare(raw,digest)['paperId'];service=ChartEditService(store)
        operations=[]
        for n,box in enumerate([[20,40,280,280],[320,40,580,280]]):
            scene=service.prepare({'paperId':pid,'fileHash':digest,'pageIndex':0,'bbox':box})
            series=scene['series'][0];p=series['points'][len(series['points'])//2]
            plan={'schema':SCHEMA,'paperId':pid,'fileHash':digest,'sceneId':scene['sceneId'],'revision':1,
                'operations':[{'id':'drag'+str(n),'kind':'deform','seriesId':series['id'],'center':[p['x'],p['y']],'radius':35,'dx':0,'dy':-20}]}
            operations.append({'id':'chart'+str(n),'kind':'chart-shape','plan':plan})
        table=store.list_items(pid,kind='table',page_index=1)['items'][0];item=store.read_item(pid,table['id'])
        cell=next(c for c in item['table']['cells'] if c['text']=='7')
        operations.append({'id':'cell','kind':'table-cell','itemId':table['id'],'row':cell['row'],'column':cell['column'],'before':'7','after':'-7.5'})
        with patch('paper_chart_edit_service.default_service',service):
            result=export_visual({'schema':'falsify.visual-edit-request.v1','paperId':pid,'fileHash':digest,'revision':'combo','operations':operations},store=store)
        self.assertEqual(len(result['changes']),3)
        self.assertEqual(result['verification']['issues'],[])
        out=base64.b64decode(result['file'])
        with pymupdf.open(stream=out,filetype='pdf') as final,pymupdf.open(stream=raw,filetype='pdf') as original:
            self.assertEqual(len(final),2)
            self.assertEqual(final[0].get_text(),original[0].get_text())
            self.assertIn('-7.5',final[1].get_text())
            self.assertNotEqual(final[0].get_pixmap().samples,original[0].get_pixmap().samples)
        self.assertEqual(store.source_bytes(pid,digest),raw)

if __name__=='__main__':unittest.main()
