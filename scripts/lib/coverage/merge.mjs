// Merge remapped measurements from different compilers only at identical source
// locations. A hit on an enclosing range is not evidence for another compiler's
// nested branch. V8 ranges from identical bundle bytes are merged before remapping.
export function canonicalizeLocations(input, sourceForPath) {
  for(const [path,raw]of Object.entries(input)){
    const file=typeof raw.toJSON==='function'?raw.toJSON():raw,lines=sourceForPath(path).split('\n');
    const position=p=>{
      // v8-to-istanbul can represent a newline as column -1 on the next line.
      // This is the same byte/UTF-16 offset as the preceding line's end.
      if(p.column===-1&&p.line>1){p.line--;p.column=lines[p.line-1].length;}
    };
    const location=loc=>{position(loc.start);position(loc.end);};
    for(const item of Object.values(file.statementMap))location(item);
    for(const item of Object.values(file.branchMap)){location(item.loc);for(const loc of item.locations)location(loc);}
    for(const item of Object.values(file.fnMap)){location(item.loc);if(item.decl)location(item.decl);}
  }
  return input;
}
export function mergeExact(...inputs) {
  const output={},placeholders=new Set();
  for(const input of inputs)for(const [path,raw]of Object.entries(input)){
    const file=typeof raw.toJSON==='function'?raw.toJSON():raw;
    if(file.all&&output[path]&&!placeholders.has(path))continue;
    if(file.all)placeholders.add(path);
    const target=output[path]??={path,statementMap:{},s:{},branchMap:{},b:{},fnMap:{},f:{}};
    if(!file.all&&placeholders.delete(path)){
      // c8's cold-file placeholder is not an observed branch. Keep its zero-hit
      // source lines, but replace synthetic branch/function shapes with real ones.
      target.branchMap={};target.b={};target.fnMap={};target.f={};
    }
    for(const [mapName,hitsName,keyOf]of [
      ['statementMap','s',item=>JSON.stringify(item)],
      ['branchMap','b',item=>JSON.stringify([item.type,item.locations])],
      ['fnMap','f',item=>JSON.stringify(item.loc)],
    ]){
      const ids=new Map(Object.entries(target[mapName]).map(([id,item])=>[keyOf(item),id]));
      for(const [id,item]of Object.entries(file[mapName])){
        const key=keyOf(item);let to=ids.get(key);
        if(to===undefined){to=String(Object.keys(target[mapName]).length);ids.set(key,to);target[mapName][to]=structuredClone(item);target[hitsName][to]=Array.isArray(file[hitsName][id])?file[hitsName][id].map(()=>0):0;}
        const hits=file[hitsName][id];
        if(Array.isArray(hits))target[hitsName][to]=target[hitsName][to].map((n,i)=>n+hits[i]);
        else target[hitsName][to]+=hits;
      }
    }
  }
  return output;
}
