"""Real SDK stdio graph edit round trip, no model calls."""
import base64
import hashlib
import json
import sys
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
import anyio
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from chart_shape_fixture import chart_pdf

LOCAL = Path(__file__).resolve().parents[1] / 'local'

class ChartMcpTests(unittest.TestCase):
    def test_native_edit_roundtrip_and_source_binding(self):
        raw = chart_pdf()
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'source.pdf'
            source.write_bytes(raw)
            async def run():
                params = StdioServerParameters(command=sys.executable,
                    args=[str(LOCAL / 'paper_chart_edit_mcp.py'), '--pdf', str(source)],
                    env={'PYTHONUTF8':'1','PYTHONIOENCODING':'utf-8'})
                with anyio.fail_after(60):
                    async with stdio_client(params) as (read, write):
                        async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=30)) as session:
                            init = await session.initialize()
                            binding = json.loads(init.instructions.split('Selected PDF: ',1)[1])
                            self.assertEqual(binding['fileHash'], hashlib.sha256(raw).hexdigest())
                            tools = (await session.list_tools()).tools
                            self.assertEqual({t.name for t in tools}, {'prepare_chart_edit','preview_chart_edit','export_chart_edit'})
                            args = {'paperId':binding['paperId'],'pageIndex':0,'bbox':[35,40,395,278]}
                            scene_result = await session.call_tool('prepare_chart_edit',args)
                            self.assertFalse(scene_result.isError, scene_result)
                            scene = scene_result.structuredContent
                            series = scene['series'][0]
                            point = series['points'][len(series['points'])//2]
                            ops = [{'id':'mcp-drag','kind':'deform','seriesId':series['id'],
                                'center':[point['x'],point['y']],'radius':35,'dx':0,'dy':-15}]
                            plan = {'paperId':binding['paperId'],'sceneId':scene['sceneId'],'revision':1,'operations':ops}
                            preview = await session.call_tool('preview_chart_edit', plan)
                            self.assertFalse(preview.isError, preview)
                            self.assertEqual(len([b for b in preview.content if b.type=='image']),1)
                            result = await session.call_tool('export_chart_edit', plan)
                            self.assertFalse(result.isError, result)
                            data = result.structuredContent
                            output = base64.b64decode(data['file'])
                            self.assertNotEqual(output,raw)
                            self.assertEqual(data['changes'][0]['author'],'agent')
                            self.assertEqual(data['verification']['issues'],[])
                            self.assertEqual(data['outputSha256'],hashlib.sha256(output).hexdigest())
                            wrong = await session.call_tool('export_chart_edit',{**plan,'paperId':'foreign'})
                            self.assertTrue(wrong.isError)
                            undo = await session.call_tool('export_chart_edit',{**plan,'revision':0,'operations':[]})
                            self.assertEqual(base64.b64decode(undo.structuredContent['file']),raw)
            anyio.run(run)
            self.assertEqual(source.read_bytes(),raw)

if __name__=='__main__':unittest.main()
